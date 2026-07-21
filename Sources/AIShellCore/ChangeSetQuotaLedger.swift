import CryptoKit
import Darwin
import Foundation

/// `apply_change_set` が書き出す全 material を、実際に encode 済みの bytes で予約する ledger。
///
/// `authorizeWrite` の成功は、対応する残量減算が durable になったことを意味する。呼び出し側は
/// その後にだけ material を書く。予約 file の縮小に失敗した場合も成功へ丸めず、同じ key の
/// retry または再起動後の `reconcile` で物理予約を ledger へ収束させる。
public actor ChangeSetQuotaLedger {
    public enum MaterialKind: String, Codable, CaseIterable, Sendable {
        case canonicalEnvelope
        case afterStage
        case rollback
        case trashBackup
        case completeDiff
        case transactionManifest
        case transactionJournal
        case evidenceData
        case evidenceMetadata
        case stateSnapshot
        case terminalReplay
    }

    public struct Material: Sendable {
        public let id: String
        public let idempotencyKey: String
        public let kind: MaterialKind
        public let encodedData: Data
        /// material が最終的に所有される volume 上の、既存 directory。
        public let allocationDirectory: URL

        public init(id: String, idempotencyKey: String, kind: MaterialKind, encodedData: Data, allocationDirectory: URL) {
            self.id = id
            self.idempotencyKey = idempotencyKey
            self.kind = kind
            self.encodedData = encodedData
            self.allocationDirectory = allocationDirectory
        }
    }

    public struct Receipt: Codable, Equatable, Sendable {
        public let materialID: String
        public let idempotencyKey: String
        public let bytes: Int
        public let remainingBytesOnVolume: Int
        public let dataSHA256: String
    }

    public struct View: Equatable, Sendable {
        public let reservationID: String
        public let ledgerBytes: Int
        public let materialBytes: Int
        public let remainingMaterialBytes: Int
        public let consumedMaterialIDs: Set<String>
        public let volumeRemainingBytes: [UInt64: Int]
    }

    public enum LedgerError: Error, Equatable, Sendable {
        case invalidIdentifier(String)
        case duplicateMaterial(String)
        case duplicateIdempotencyKey(String)
        case missingDirectory(String)
        case volumeUnavailable(String)
        case volumeMismatch(materialID: String)
        case differentLedgerVolume
        case alreadyPreparedWithDifferentPlan
        case notPrepared
        case unknownMaterial(String)
        case idempotencyMismatch(String)
        case contentMismatch(String)
        case quotaExhausted(volume: UInt64, required: Int, remaining: Int)
        case preallocationFailed(volume: UInt64, errno: Int32)
        case durableWriteFailed(String)
        case corruptLedger(String)
        case physicalReservationNotConverged(volume: UInt64)
    }

    private struct MaterialRecord: Codable, Equatable {
        let id: String
        let idempotencyKey: String
        let kind: MaterialKind
        let bytes: String
        let sha256: String
        let volume: String
        let status: Int
    }

    private struct VolumeRecord: Codable, Equatable {
        let device: String
        let directoryPath: String
        let reserveFilePath: String
        let totalBytes: String
        let remainingBytes: String
    }

    private struct Snapshot: Codable, Equatable {
        let schema: String
        let reservationID: String
        let ledgerDevice: String
        let ledgerBytes: String
        let materials: [MaterialRecord]
        let volumes: [VolumeRecord]
    }

    private static let schema = "aishell.change-set-quota-ledger.v1"
    private static let numberWidth = 20

    private let ledgerDirectory: URL
    private let reservationID: String
    private let ledgerURL: URL

    public init(ledgerDirectory: URL, reservationID: String) throws {
        guard Self.validIdentifier(reservationID) else { throw LedgerError.invalidIdentifier(reservationID) }
        self.ledgerDirectory = ledgerDirectory.standardizedFileURL.resolvingSymlinksInPath()
        self.reservationID = reservationID
        self.ledgerURL = self.ledgerDirectory.appendingPathComponent("quota-\(reservationID).json")
    }

    /// 全 material と ledger 自身の encoded size を確定し、各所有 volume に物理領域を予約する。
    @discardableResult
    public func prepare(_ materials: [Material]) throws -> View {
        let ledgerDevice = try Self.device(ofExistingDirectory: ledgerDirectory)
        var ids = Set<String>(), keys = Set<String>()
        var materialRecords: [MaterialRecord] = []
        var directories: [UInt64: URL] = [:]
        var materialBytesByVolume: [UInt64: Int] = [:]

        for material in materials {
            guard Self.validIdentifier(material.id) else { throw LedgerError.invalidIdentifier(material.id) }
            guard !material.idempotencyKey.isEmpty, material.idempotencyKey.utf8.count <= 512 else {
                throw LedgerError.invalidIdentifier(material.idempotencyKey)
            }
            guard ids.insert(material.id).inserted else { throw LedgerError.duplicateMaterial(material.id) }
            guard keys.insert(material.idempotencyKey).inserted else { throw LedgerError.duplicateIdempotencyKey(material.idempotencyKey) }
            let directory = material.allocationDirectory.standardizedFileURL.resolvingSymlinksInPath()
            let device = try Self.device(ofExistingDirectory: directory)
            // stage、Trash、Evidence が同じ volume の別directoryでも、一 volume 一予約へ集約する。
            // request順に依存しないよう reservation の設置先は辞書順で決める。
            if let existing = directories[device] {
                directories[device] = existing.path < directory.path ? existing : directory
            } else {
                directories[device] = directory
            }
            materialBytesByVolume[device, default: 0] = try Self.checkedAdd(materialBytesByVolume[device, default: 0], material.encodedData.count)
            materialRecords.append(.init(
                id: material.id,
                idempotencyKey: material.idempotencyKey,
                kind: material.kind,
                bytes: Self.fixed(material.encodedData.count),
                sha256: Self.sha256(material.encodedData),
                volume: Self.fixed(device),
                status: 0
            ))
        }
        materialRecords.sort { $0.id < $1.id }

        // ledger 自身も ledger volume の quota に含める。固定幅数値により、残量・status変更後も
        // snapshot length は不変になる。反復は自己参照 field が実 encoded lengthへ収束したことを検証する。
        if directories[ledgerDevice] == nil { directories[ledgerDevice] = ledgerDirectory }
        var ledgerBytes = 0
        var candidate: Snapshot!
        for _ in 0..<32 {
            let volumes = directories.keys.sorted().map { device -> VolumeRecord in
                let materialBytes = materialBytesByVolume[device, default: 0]
                let total = materialBytes + (device == ledgerDevice ? ledgerBytes : 0)
                let directory = directories[device]!
                return .init(
                    device: Self.fixed(device),
                    directoryPath: directory.path,
                    reserveFilePath: directory.appendingPathComponent(".aishell-quota-\(reservationID)-\(device).reserve").path,
                    totalBytes: Self.fixed(total),
                    remainingBytes: Self.fixed(materialBytes)
                )
            }
            candidate = .init(schema: Self.schema, reservationID: reservationID, ledgerDevice: Self.fixed(ledgerDevice), ledgerBytes: Self.fixed(ledgerBytes), materials: materialRecords, volumes: volumes)
            let encodedCount = try Self.encode(candidate).count
            if encodedCount == ledgerBytes { break }
            ledgerBytes = encodedCount
        }
        guard try Self.encode(candidate).count == ledgerBytes else { throw LedgerError.corruptLedger("ledger size fixed-point did not converge") }

        // 最終 fixed-point 値を totalBytes に反映した snapshot を一度だけ再構築する。
        candidate = Self.replacingLedgerBytes(candidate, ledgerBytes: ledgerBytes)
        let encoded = try Self.encode(candidate)
        guard encoded.count == ledgerBytes else { throw LedgerError.corruptLedger("ledger size changed after convergence") }

        if FileManager.default.fileExists(atPath: ledgerURL.path) {
            let existing = try load()
            guard Self.samePlan(existing, candidate) else { throw LedgerError.alreadyPreparedWithDifferentPlan }
            try reconcile(snapshot: existing)
            return Self.view(existing)
        }

        var created: [URL] = []
        do {
            for volume in candidate.volumes {
                let total = try Self.parse(volume.totalBytes)
                let reserveURL = URL(fileURLWithPath: volume.reserveFilePath)
                try Self.preallocate(reserveURL, bytes: total)
                created.append(reserveURL)
            }
            try Self.atomicDurableWrite(encoded, to: ledgerURL)
            // ledger bytes are now materialized; only future material bytes remain in the companion file.
            try reconcile(snapshot: candidate)
            return Self.view(candidate)
        } catch {
            if !FileManager.default.fileExists(atPath: ledgerURL.path) {
                for url in created { try? FileManager.default.removeItem(at: url) }
            }
            throw error
        }
    }

    /// material 書込み直前の durable admission。成功後にだけ呼び出し側が `data` を書ける。
    public func authorizeWrite(materialID: String, idempotencyKey: String, data: Data) throws -> Receipt {
        var snapshot = try load()
        guard let index = snapshot.materials.firstIndex(where: { $0.id == materialID }) else { throw LedgerError.unknownMaterial(materialID) }
        let material = snapshot.materials[index]
        guard material.idempotencyKey == idempotencyKey else { throw LedgerError.idempotencyMismatch(materialID) }
        guard material.sha256 == Self.sha256(data), try Self.parse(material.bytes) == data.count else { throw LedgerError.contentMismatch(materialID) }
        let device = try Self.parseUInt(material.volume)

        if material.status == 1 {
            try reconcile(snapshot: snapshot)
            return Self.receipt(material, snapshot: snapshot)
        }
        guard let volumeIndex = snapshot.volumes.firstIndex(where: { (try? Self.parseUInt($0.device)) == device }) else {
            throw LedgerError.corruptLedger("material volume is absent")
        }
        let remaining = try Self.parse(snapshot.volumes[volumeIndex].remainingBytes)
        let bytes = data.count
        guard remaining >= bytes else { throw LedgerError.quotaExhausted(volume: device, required: bytes, remaining: remaining) }

        snapshot = Self.consuming(snapshot, materialIndex: index, volumeIndex: volumeIndex, bytes: bytes)
        let encoded = try Self.encode(snapshot)
        let expectedLedgerBytes = try Self.parse(snapshot.ledgerBytes)
        guard encoded.count == expectedLedgerBytes else { throw LedgerError.corruptLedger("ledger encoded size is not invariant") }
        try Self.atomicDurableWrite(encoded, to: ledgerURL)
        do {
            try reconcile(snapshot: snapshot)
        } catch {
            throw LedgerError.physicalReservationNotConverged(volume: device)
        }
        return Self.receipt(snapshot.materials[index], snapshot: snapshot)
    }

    /// crash後、durable ledgerを正本として全 volume の物理予約sizeを収束させる。
    @discardableResult
    public func reconcile() throws -> View {
        let snapshot = try load()
        try reconcile(snapshot: snapshot)
        return Self.view(snapshot)
    }

    public func currentView() throws -> View { Self.view(try load()) }

    private func load() throws -> Snapshot {
        guard FileManager.default.fileExists(atPath: ledgerURL.path) else { throw LedgerError.notPrepared }
        do {
            let data = try Data(contentsOf: ledgerURL)
            let snapshot = try JSONDecoder().decode(Snapshot.self, from: data)
            let expectedLedgerBytes = try Self.parse(snapshot.ledgerBytes)
            guard snapshot.schema == Self.schema, snapshot.reservationID == reservationID,
                  data.count == expectedLedgerBytes else { throw LedgerError.corruptLedger("header or byte length mismatch") }
            return snapshot
        } catch let error as LedgerError { throw error }
        catch { throw LedgerError.corruptLedger(String(describing: error)) }
    }

    private func reconcile(snapshot: Snapshot) throws {
        let ledgerDevice = try Self.device(ofExistingDirectory: ledgerDirectory)
        let expectedLedgerDevice = try Self.parseUInt(snapshot.ledgerDevice)
        guard ledgerDevice == expectedLedgerDevice else { throw LedgerError.differentLedgerVolume }
        for volume in snapshot.volumes {
            let device = try Self.parseUInt(volume.device)
            let directory = URL(fileURLWithPath: volume.directoryPath)
            guard try Self.device(ofExistingDirectory: directory) == device else { throw LedgerError.differentLedgerVolume }
            let remaining = try Self.parse(volume.remainingBytes)
            let reserve = URL(fileURLWithPath: volume.reserveFilePath)
            let descriptor = open(reserve.path, O_RDWR | O_CLOEXEC | O_NOFOLLOW)
            guard descriptor >= 0 else { throw LedgerError.physicalReservationNotConverged(volume: device) }
            defer { close(descriptor) }
            var info = stat()
            guard fstat(descriptor, &info) == 0, UInt64(info.st_dev) == device else { throw LedgerError.differentLedgerVolume }
            if Int(info.st_size) != remaining {
                guard ftruncate(descriptor, off_t(remaining)) == 0, fsync(descriptor) == 0 else {
                    throw LedgerError.physicalReservationNotConverged(volume: device)
                }
            }
        }
    }

    private static func replacingLedgerBytes(_ snapshot: Snapshot, ledgerBytes: Int) -> Snapshot {
        let ledgerDevice = try! parseUInt(snapshot.ledgerDevice)
        let volumes = snapshot.volumes.map { volume -> VolumeRecord in
            guard try! parseUInt(volume.device) == ledgerDevice else { return volume }
            let remaining = try! parse(volume.remainingBytes)
            return .init(device: volume.device, directoryPath: volume.directoryPath, reserveFilePath: volume.reserveFilePath,
                         totalBytes: fixed(remaining + ledgerBytes), remainingBytes: volume.remainingBytes)
        }
        return .init(schema: snapshot.schema, reservationID: snapshot.reservationID, ledgerDevice: snapshot.ledgerDevice,
                     ledgerBytes: fixed(ledgerBytes), materials: snapshot.materials, volumes: volumes)
    }

    private static func consuming(_ snapshot: Snapshot, materialIndex: Int, volumeIndex: Int, bytes: Int) -> Snapshot {
        var materials = snapshot.materials, volumes = snapshot.volumes
        let material = materials[materialIndex]
        materials[materialIndex] = .init(id: material.id, idempotencyKey: material.idempotencyKey, kind: material.kind,
                                         bytes: material.bytes, sha256: material.sha256, volume: material.volume, status: 1)
        let volume = volumes[volumeIndex]
        let remaining = (try! parse(volume.remainingBytes)) - bytes
        volumes[volumeIndex] = .init(device: volume.device, directoryPath: volume.directoryPath, reserveFilePath: volume.reserveFilePath,
                                     totalBytes: volume.totalBytes, remainingBytes: fixed(remaining))
        return .init(schema: snapshot.schema, reservationID: snapshot.reservationID, ledgerDevice: snapshot.ledgerDevice,
                     ledgerBytes: snapshot.ledgerBytes, materials: materials, volumes: volumes)
    }

    private static func receipt(_ material: MaterialRecord, snapshot: Snapshot) -> Receipt {
        let volume = snapshot.volumes.first { $0.device == material.volume }!
        return .init(materialID: material.id, idempotencyKey: material.idempotencyKey, bytes: try! parse(material.bytes),
                     remainingBytesOnVolume: try! parse(volume.remainingBytes), dataSHA256: material.sha256)
    }

    private static func view(_ snapshot: Snapshot) -> View {
        let materialBytes = snapshot.materials.reduce(0) { $0 + (try! parse($1.bytes)) }
        let remaining = snapshot.volumes.reduce(0) { $0 + (try! parse($1.remainingBytes)) }
        return .init(reservationID: snapshot.reservationID, ledgerBytes: try! parse(snapshot.ledgerBytes), materialBytes: materialBytes,
                     remainingMaterialBytes: remaining, consumedMaterialIDs: Set(snapshot.materials.filter { $0.status == 1 }.map(\.id)),
                     volumeRemainingBytes: Dictionary(uniqueKeysWithValues: snapshot.volumes.map { (try! parseUInt($0.device), try! parse($0.remainingBytes)) }))
    }

    private static func samePlan(_ lhs: Snapshot, _ rhs: Snapshot) -> Bool {
        guard lhs.schema == rhs.schema, lhs.reservationID == rhs.reservationID,
              lhs.ledgerDevice == rhs.ledgerDevice, lhs.ledgerBytes == rhs.ledgerBytes else { return false }
        let normalizedMaterials = lhs.materials.map {
            MaterialRecord(id: $0.id, idempotencyKey: $0.idempotencyKey, kind: $0.kind,
                           bytes: $0.bytes, sha256: $0.sha256, volume: $0.volume, status: 0)
        }
        guard normalizedMaterials == rhs.materials, lhs.volumes.count == rhs.volumes.count else { return false }
        return zip(lhs.volumes, rhs.volumes).allSatisfy {
            $0.device == $1.device && $0.directoryPath == $1.directoryPath && $0.totalBytes == $1.totalBytes
        }
    }

    private static func preallocate(_ url: URL, bytes: Int) throws {
        let descriptor = open(url.path, O_RDWR | O_CREAT | O_EXCL | O_CLOEXEC | O_NOFOLLOW, 0o600)
        guard descriptor >= 0 else { throw LedgerError.preallocationFailed(volume: 0, errno: errno) }
        var info = stat()
        guard fstat(descriptor, &info) == 0 else { let value = errno; close(descriptor); throw LedgerError.preallocationFailed(volume: 0, errno: value) }
        let device = UInt64(info.st_dev)
        var allocation = fstore_t(fst_flags: UInt32(F_ALLOCATEALL), fst_posmode: Int32(F_PEOFPOSMODE), fst_offset: 0, fst_length: off_t(bytes), fst_bytesalloc: 0)
        guard fcntl(descriptor, F_PREALLOCATE, &allocation) != -1, allocation.fst_bytesalloc >= bytes,
              ftruncate(descriptor, off_t(bytes)) == 0, fsync(descriptor) == 0 else {
            let value = errno; close(descriptor); try? FileManager.default.removeItem(at: url)
            throw LedgerError.preallocationFailed(volume: device, errno: value)
        }
        guard close(descriptor) == 0 else { throw LedgerError.preallocationFailed(volume: device, errno: errno) }
    }

    private static func atomicDurableWrite(_ data: Data, to destination: URL) throws {
        let temporary = destination.deletingLastPathComponent().appendingPathComponent(".\(destination.lastPathComponent).tmp")
        let descriptor = open(temporary.path, O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC | O_NOFOLLOW, 0o600)
        guard descriptor >= 0 else { throw LedgerError.durableWriteFailed("open: \(errno)") }
        do {
            try data.withUnsafeBytes { raw in
                var remaining = raw.count
                var address = raw.baseAddress
                while remaining > 0 {
                    let wrote = Darwin.write(descriptor, address, remaining)
                    guard wrote > 0 else { throw LedgerError.durableWriteFailed("write: \(errno)") }
                    remaining -= wrote; address = address?.advanced(by: wrote)
                }
            }
            guard fsync(descriptor) == 0, close(descriptor) == 0,
                  rename(temporary.path, destination.path) == 0 else { throw LedgerError.durableWriteFailed("fsync/rename: \(errno)") }
            let directoryFD = open(destination.deletingLastPathComponent().path, O_RDONLY | O_DIRECTORY | O_CLOEXEC)
            guard directoryFD >= 0, fsync(directoryFD) == 0, close(directoryFD) == 0 else {
                if directoryFD >= 0 { close(directoryFD) }
                throw LedgerError.durableWriteFailed("directory fsync: \(errno)")
            }
        } catch {
            close(descriptor); try? FileManager.default.removeItem(at: temporary); throw error
        }
    }

    private static func device(ofExistingDirectory url: URL) throws -> UInt64 {
        var info = stat()
        guard lstat(url.path, &info) == 0, (info.st_mode & S_IFMT) == S_IFDIR else {
            if errno == ENOENT { throw LedgerError.missingDirectory(url.path) }
            throw LedgerError.volumeUnavailable(url.path)
        }
        return UInt64(info.st_dev)
    }

    private static func encode(_ snapshot: Snapshot) throws -> Data {
        let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        return try encoder.encode(snapshot)
    }
    private static func sha256(_ data: Data) -> String { SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined() }
    private static func validIdentifier(_ value: String) -> Bool {
        !value.isEmpty && value.utf8.count <= 128 && value.unicodeScalars.allSatisfy { CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "_-")).contains($0) }
    }
    private static func fixed<T: BinaryInteger>(_ value: T) -> String { String(repeating: "0", count: numberWidth - String(value).count) + String(value) }
    private static func parse(_ value: String) throws -> Int {
        guard value.count == numberWidth, let parsed = Int(value) else { throw LedgerError.corruptLedger("invalid fixed integer") }
        return parsed
    }
    private static func parseUInt(_ value: String) throws -> UInt64 {
        guard value.count == numberWidth, let parsed = UInt64(value) else { throw LedgerError.corruptLedger("invalid fixed unsigned integer") }
        return parsed
    }
    private static func checkedAdd(_ lhs: Int, _ rhs: Int) throws -> Int {
        let (value, overflow) = lhs.addingReportingOverflow(rhs)
        guard !overflow, value >= 0 else { throw LedgerError.corruptLedger("byte count overflow") }
        return value
    }
}
