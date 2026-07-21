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

    /// admission前に決定できる契約上限。実materialの生成やstage inodeは要求しない。
    public struct Capacity: Sendable {
        public let id: String
        public let idempotencyKey: String
        public let kind: MaterialKind
        public let maximumEncodedBytes: Int
        public let allocationDirectory: URL

        public init(id: String, idempotencyKey: String, kind: MaterialKind, maximumEncodedBytes: Int, allocationDirectory: URL) {
            self.id = id
            self.idempotencyKey = idempotencyKey
            self.kind = kind
            self.maximumEncodedBytes = maximumEncodedBytes
            self.allocationDirectory = allocationDirectory
        }
    }

    /// callerが後続materialのinodeとして直接利用できる、物理予約済みextent。
    public struct AdoptedReserve: Equatable, Sendable {
        public let materialID: String
        public let idempotencyKey: String
        public let extentURL: URL
        public let capacityBytes: Int
        public let plannedFinalURL: URL
    }

    public struct MaterializationReceipt: Equatable, Sendable {
        public let materialID: String
        public let idempotencyKey: String
        public let finalURL: URL
        public let device: UInt64
        public let inode: UInt64
        public let bytes: Int
        public let sha256: String
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
        case capacityExceeded(materialID: String, capacity: Int, actual: Int)
        case reserveNotAdopted(String)
        case quotaExhausted(volume: UInt64, required: Int, remaining: Int)
        case preallocationFailed(volume: UInt64, errno: Int32)
        case durableWriteFailed(String)
        case corruptLedger(String)
        case physicalReservationNotConverged(volume: UInt64)
        case finalPathMismatch(String)
        case materializationIncomplete(String)
    }

    private struct MaterialRecord: Codable, Equatable {
        let id: String
        let idempotencyKey: String
        let kind: MaterialKind
        let bytes: String
        let actualBytes: String
        let expectedSHA256: String
        let sha256: String
        let volume: String
        let extentFilePath: String
        let plannedFinalPathHex: String
        let plannedFinalPathBytes: String
        let finalDevice: String
        let finalInode: String
        let finalBytes: String
        let finalSHA256: String
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

    private struct MaterialIdentity {
        let device: UInt64
        let inode: UInt64
        let bytes: Int
        let sha256: String
    }

    private static let schema = "aishell.change-set-quota-ledger.v1"
    private static let numberWidth = 20
    private static let maximumPathBytes = 4_096

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
        try prepareRecords(materials.map {
            ($0.id, $0.idempotencyKey, $0.kind, $0.encodedData.count, $0.allocationDirectory, Self.sha256($0.encodedData))
        })
    }

    /// admission前に、request上限と決定的なworst-case encodingだけから物理capacityを確保する。
    /// 実manifest、journal、artifact、terminal bytesはここでは要求しない。
    @discardableResult
    public func prepareCapacity(_ capacities: [Capacity]) throws -> View {
        try prepareRecords(capacities.map {
            ($0.id, $0.idempotencyKey, $0.kind, $0.maximumEncodedBytes, $0.allocationDirectory, nil)
        })
    }

    private func prepareRecords(_ inputs: [(id: String, key: String, kind: MaterialKind, capacity: Int, directory: URL, expectedSHA: String?)]) throws -> View {
        let ledgerDevice = try Self.device(ofExistingDirectory: ledgerDirectory)
        var ids = Set<String>(), keys = Set<String>()
        var materialRecords: [MaterialRecord] = []
        var directories: [UInt64: URL] = [:]
        var materialBytesByVolume: [UInt64: Int] = [:]

        for input in inputs {
            guard Self.validIdentifier(input.id) else { throw LedgerError.invalidIdentifier(input.id) }
            guard !input.key.isEmpty, input.key.utf8.count <= 512, input.capacity >= 0 else {
                throw LedgerError.invalidIdentifier(input.key)
            }
            guard ids.insert(input.id).inserted else { throw LedgerError.duplicateMaterial(input.id) }
            guard keys.insert(input.key).inserted else { throw LedgerError.duplicateIdempotencyKey(input.key) }
            let directory = input.directory.standardizedFileURL.resolvingSymlinksInPath()
            let device = try Self.device(ofExistingDirectory: directory)
            // stage、Trash、Evidence が同じ volume の別directoryでも、一 volume 一予約へ集約する。
            // request順に依存しないよう reservation の設置先は辞書順で決める。
            if let existing = directories[device] {
                directories[device] = existing.path < directory.path ? existing : directory
            } else {
                directories[device] = directory
            }
            materialBytesByVolume[device, default: 0] = try Self.checkedAdd(materialBytesByVolume[device, default: 0], input.capacity)
            materialRecords.append(.init(
                id: input.id,
                idempotencyKey: input.key,
                kind: input.kind,
                bytes: Self.fixed(input.capacity),
                actualBytes: Self.fixed(0),
                expectedSHA256: input.expectedSHA ?? Self.zeroDigest,
                sha256: Self.zeroDigest,
                volume: Self.fixed(device),
                extentFilePath: directory.appendingPathComponent(".aishell-quota-\(reservationID)-material-\(input.id).extent").path,
                plannedFinalPathHex: Self.emptyPathHex,
                plannedFinalPathBytes: Self.fixed(0),
                finalDevice: Self.fixed(0), finalInode: Self.fixed(0), finalBytes: Self.fixed(0),
                finalSHA256: Self.zeroDigest,
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
                    reserveFilePath: device == ledgerDevice
                        ? ledgerDirectory.appendingPathComponent(".aishell-quota-\(reservationID)-ledger.reserve").path
                        : "",
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
            for material in candidate.materials {
                let reserveURL = URL(fileURLWithPath: material.extentFilePath)
                try Self.preallocate(reserveURL, bytes: try Self.parse(material.bytes))
                created.append(reserveURL)
            }
            let ledgerReserve = ledgerDirectory.appendingPathComponent(".aishell-quota-\(reservationID)-ledger.reserve")
            try Self.preallocate(ledgerReserve, bytes: ledgerBytes)
            created.append(ledgerReserve)
            try Self.atomicDurableWrite(encoded, to: ledgerURL)
            try Self.resizeAndSync(ledgerReserve, bytes: 0)
            // ledger bytes are now materialized; material extents remain preallocated at contract capacity.
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
        _ = try adoptReserve(materialID: materialID, idempotencyKey: idempotencyKey)
        return try authorizeActual(materialID: materialID, idempotencyKey: idempotencyKey, data: data)
    }

    /// `prepareCapacity` が確保したextentを後続materialの所有物としてdurableに採用する。
    /// extentは同一volume上でcallerが直接writeし、最終pathへatomic renameできる。
    public func adoptReserve(materialID: String, idempotencyKey: String) throws -> AdoptedReserve {
        let snapshot = try load()
        guard let material = snapshot.materials.first(where: { $0.id == materialID }) else { throw LedgerError.unknownMaterial(materialID) }
        return try adoptReserve(materialID: materialID, idempotencyKey: idempotencyKey,
                                finalURL: URL(fileURLWithPath: material.extentFilePath))
    }

    public func adoptReserve(materialID: String, idempotencyKey: String, finalURL: URL) throws -> AdoptedReserve {
        var snapshot = try load()
        guard let index = snapshot.materials.firstIndex(where: { $0.id == materialID }) else { throw LedgerError.unknownMaterial(materialID) }
        let material = snapshot.materials[index]
        guard material.idempotencyKey == idempotencyKey else { throw LedgerError.idempotencyMismatch(materialID) }
        let canonicalFinal = try Self.canonicalPlannedFinal(finalURL)
        let planned = try Self.encodePath(canonicalFinal.path)
        let device = try Self.parseUInt(material.volume)
        guard try Self.device(ofExistingDirectory: canonicalFinal.deletingLastPathComponent()) == device else { throw LedgerError.differentLedgerVolume }
        if material.status >= 1 {
            guard try Self.plannedFinalURL(material).path == canonicalFinal.path else { throw LedgerError.finalPathMismatch(materialID) }
            return Self.adoptedReserve(material)
        }
        let extent = URL(fileURLWithPath: material.extentFilePath)
        let capacity = try Self.parse(material.bytes)
        try Self.requireExtent(extent, device: device, size: capacity)
        snapshot = Self.adopting(snapshot, materialIndex: index, pathHex: planned.hex, pathBytes: planned.bytes)
        let encoded = try Self.encode(snapshot)
        let expectedLedgerBytes = try Self.parse(snapshot.ledgerBytes)
        guard encoded.count == expectedLedgerBytes else { throw LedgerError.corruptLedger("ledger encoded size is not invariant") }
        try Self.atomicDurableWrite(encoded, to: ledgerURL)
        return Self.adoptedReserve(snapshot.materials[index])
    }

    /// admission後に初めて得られる実encoded bytesをcapacity内でreceipt化し、extentを実sizeへ移譲する。
    public func authorizeActual(materialID: String, idempotencyKey: String, data: Data) throws -> Receipt {
        var snapshot = try load()
        guard let index = snapshot.materials.firstIndex(where: { $0.id == materialID }) else { throw LedgerError.unknownMaterial(materialID) }
        let material = snapshot.materials[index]
        guard material.idempotencyKey == idempotencyKey else { throw LedgerError.idempotencyMismatch(materialID) }
        guard material.status >= 1 else { throw LedgerError.reserveNotAdopted(materialID) }
        let capacity = try Self.parse(material.bytes)
        guard data.count <= capacity else { throw LedgerError.capacityExceeded(materialID: materialID, capacity: capacity, actual: data.count) }
        let digest = Self.sha256(data)
        if material.expectedSHA256 != Self.zeroDigest, material.expectedSHA256 != digest { throw LedgerError.contentMismatch(materialID) }
        let device = try Self.parseUInt(material.volume)

        if material.status == 2 {
            guard try Self.parse(material.actualBytes) == data.count, material.sha256 == digest else { throw LedgerError.contentMismatch(materialID) }
            try reconcile(snapshot: snapshot)
            return Self.receipt(material, snapshot: snapshot)
        }
        guard let volumeIndex = snapshot.volumes.firstIndex(where: { (try? Self.parseUInt($0.device)) == device }) else {
            throw LedgerError.corruptLedger("material volume is absent")
        }
        let remaining = try Self.parse(snapshot.volumes[volumeIndex].remainingBytes)
        guard remaining >= capacity else { throw LedgerError.quotaExhausted(volume: device, required: capacity, remaining: remaining) }

        snapshot = Self.authorizing(snapshot, materialIndex: index, volumeIndex: volumeIndex, actualBytes: data.count, digest: digest)
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

    /// extentを予定final pathへatomic renameした後、そのinodeをledgerの新しい照合正本にする。
    public func commitMaterialization(materialID: String, idempotencyKey: String, finalURL: URL) throws -> MaterializationReceipt {
        var snapshot = try load()
        guard let index = snapshot.materials.firstIndex(where: { $0.id == materialID }) else { throw LedgerError.unknownMaterial(materialID) }
        let material = snapshot.materials[index]
        guard material.idempotencyKey == idempotencyKey else { throw LedgerError.idempotencyMismatch(materialID) }
        guard material.status == 2 || material.status == 3 else { throw LedgerError.materializationIncomplete(materialID) }
        let canonical = try Self.canonicalPlannedFinal(finalURL)
        let plannedFinal = try Self.plannedFinalURL(material)
        guard canonical.path == plannedFinal.path else { throw LedgerError.finalPathMismatch(materialID) }
        let identity = try Self.inspectMaterialized(canonical, expectedDevice: try Self.parseUInt(material.volume),
                                                    expectedBytes: try Self.parse(material.actualBytes), expectedSHA: material.sha256)
        if material.status == 3 {
            try Self.validateStoredIdentity(material, identity: identity)
            return Self.materializationReceipt(material, identity: identity)
        }
        snapshot = Self.materializing(snapshot, materialIndex: index, identity: identity)
        try persist(snapshot)
        return Self.materializationReceipt(snapshot.materials[index], identity: identity)
    }

    /// terminal replayがdurableになった後、ledgerのextent/final検証責務を明示的に終了する。
    /// final material自体は削除しない。
    public func releaseMaterial(materialID: String, idempotencyKey: String) throws {
        var snapshot = try load()
        guard let index = snapshot.materials.firstIndex(where: { $0.id == materialID }) else { throw LedgerError.unknownMaterial(materialID) }
        let material = snapshot.materials[index]
        guard material.idempotencyKey == idempotencyKey else { throw LedgerError.idempotencyMismatch(materialID) }
        if material.status == 4 { return }
        guard material.status == 3 else { throw LedgerError.materializationIncomplete(materialID) }
        let extent = URL(fileURLWithPath: material.extentFilePath)
        let final = try Self.plannedFinalURL(material)
        if extent.path != final.path, FileManager.default.fileExists(atPath: extent.path) { try FileManager.default.removeItem(at: extent) }
        snapshot = Self.settingTerminalReleased(snapshot, materialIndex: index)
        try persist(snapshot)
    }

    /// crash後、durable ledgerを正本として全 volume の物理予約sizeを収束させる。
    @discardableResult
    public func reconcile() throws -> View {
        let snapshot = try load()
        try reconcile(snapshot: snapshot)
        return Self.view(snapshot)
    }

    public func currentView() throws -> View { Self.view(try load()) }

    private func persist(_ snapshot: Snapshot) throws {
        let encoded = try Self.encode(snapshot)
        let expectedLedgerBytes = try Self.parse(snapshot.ledgerBytes)
        guard encoded.count == expectedLedgerBytes else { throw LedgerError.corruptLedger("ledger encoded size is not invariant") }
        try Self.atomicDurableWrite(encoded, to: ledgerURL)
    }

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

    private func reconcile(snapshot initial: Snapshot) throws {
        var snapshot = initial
        let ledgerDevice = try Self.device(ofExistingDirectory: ledgerDirectory)
        let expectedLedgerDevice = try Self.parseUInt(snapshot.ledgerDevice)
        guard ledgerDevice == expectedLedgerDevice else { throw LedgerError.differentLedgerVolume }
        for volume in snapshot.volumes {
            let device = try Self.parseUInt(volume.device)
            let directory = URL(fileURLWithPath: volume.directoryPath)
            guard try Self.device(ofExistingDirectory: directory) == device else { throw LedgerError.differentLedgerVolume }
            if !volume.reserveFilePath.isEmpty {
                try Self.resizeAndSync(URL(fileURLWithPath: volume.reserveFilePath), bytes: 0)
            }
        }
        for index in snapshot.materials.indices {
            let material = snapshot.materials[index]
            if material.status == 4 { continue }
            let device = try Self.parseUInt(material.volume)
            let extent = URL(fileURLWithPath: material.extentFilePath)
            if material.status == 3 {
                let identity = try Self.inspectMaterialized(try Self.plannedFinalURL(material), expectedDevice: device,
                                                            expectedBytes: try Self.parse(material.actualBytes), expectedSHA: material.sha256)
                try Self.validateStoredIdentity(material, identity: identity)
                continue
            }
            if material.status == 2, !FileManager.default.fileExists(atPath: extent.path) {
                let identity = try Self.inspectMaterialized(try Self.plannedFinalURL(material), expectedDevice: device,
                                                            expectedBytes: try Self.parse(material.actualBytes), expectedSHA: material.sha256)
                snapshot = Self.materializing(snapshot, materialIndex: index, identity: identity)
                try persist(snapshot)
                continue
            }
            let expectedSize = material.status == 2 ? try Self.parse(material.actualBytes) : try Self.parse(material.bytes)
            do { try Self.resizeAndSync(extent, bytes: expectedSize, expectedDevice: device) }
            catch { throw LedgerError.physicalReservationNotConverged(volume: device) }
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

    private static func adopting(_ snapshot: Snapshot, materialIndex: Int, pathHex: String, pathBytes: String) -> Snapshot {
        var materials = snapshot.materials
        let material = materials[materialIndex]
        materials[materialIndex] = .init(id: material.id, idempotencyKey: material.idempotencyKey, kind: material.kind,
                                         bytes: material.bytes, actualBytes: material.actualBytes,
                                         expectedSHA256: material.expectedSHA256, sha256: material.sha256,
                                         volume: material.volume, extentFilePath: material.extentFilePath,
                                         plannedFinalPathHex: pathHex, plannedFinalPathBytes: pathBytes,
                                         finalDevice: material.finalDevice, finalInode: material.finalInode,
                                         finalBytes: material.finalBytes, finalSHA256: material.finalSHA256, status: 1)
        return .init(schema: snapshot.schema, reservationID: snapshot.reservationID, ledgerDevice: snapshot.ledgerDevice,
                     ledgerBytes: snapshot.ledgerBytes, materials: materials, volumes: snapshot.volumes)
    }

    private static func authorizing(_ snapshot: Snapshot, materialIndex: Int, volumeIndex: Int, actualBytes: Int, digest: String) -> Snapshot {
        var materials = snapshot.materials, volumes = snapshot.volumes
        let material = materials[materialIndex]
        materials[materialIndex] = .init(id: material.id, idempotencyKey: material.idempotencyKey, kind: material.kind,
                                         bytes: material.bytes, actualBytes: fixed(actualBytes), expectedSHA256: material.expectedSHA256,
                                         sha256: digest, volume: material.volume, extentFilePath: material.extentFilePath,
                                         plannedFinalPathHex: material.plannedFinalPathHex, plannedFinalPathBytes: material.plannedFinalPathBytes,
                                         finalDevice: material.finalDevice, finalInode: material.finalInode,
                                         finalBytes: material.finalBytes, finalSHA256: material.finalSHA256, status: 2)
        let volume = volumes[volumeIndex]
        let remaining = (try! parse(volume.remainingBytes)) - (try! parse(material.bytes))
        volumes[volumeIndex] = .init(device: volume.device, directoryPath: volume.directoryPath, reserveFilePath: volume.reserveFilePath,
                                     totalBytes: volume.totalBytes, remainingBytes: fixed(remaining))
        return .init(schema: snapshot.schema, reservationID: snapshot.reservationID, ledgerDevice: snapshot.ledgerDevice,
                     ledgerBytes: snapshot.ledgerBytes, materials: materials, volumes: volumes)
    }

    private static func materializing(_ snapshot: Snapshot, materialIndex: Int, identity: MaterialIdentity) -> Snapshot {
        var materials = snapshot.materials
        let material = materials[materialIndex]
        materials[materialIndex] = .init(
            id: material.id, idempotencyKey: material.idempotencyKey, kind: material.kind,
            bytes: material.bytes, actualBytes: material.actualBytes, expectedSHA256: material.expectedSHA256,
            sha256: material.sha256, volume: material.volume, extentFilePath: material.extentFilePath,
            plannedFinalPathHex: material.plannedFinalPathHex, plannedFinalPathBytes: material.plannedFinalPathBytes,
            finalDevice: fixed(identity.device), finalInode: fixed(identity.inode), finalBytes: fixed(identity.bytes),
            finalSHA256: identity.sha256, status: 3
        )
        return .init(schema: snapshot.schema, reservationID: snapshot.reservationID, ledgerDevice: snapshot.ledgerDevice,
                     ledgerBytes: snapshot.ledgerBytes, materials: materials, volumes: snapshot.volumes)
    }

    private static func settingTerminalReleased(_ snapshot: Snapshot, materialIndex: Int) -> Snapshot {
        var materials = snapshot.materials
        let material = materials[materialIndex]
        materials[materialIndex] = .init(
            id: material.id, idempotencyKey: material.idempotencyKey, kind: material.kind,
            bytes: material.bytes, actualBytes: material.actualBytes, expectedSHA256: material.expectedSHA256,
            sha256: material.sha256, volume: material.volume, extentFilePath: material.extentFilePath,
            plannedFinalPathHex: material.plannedFinalPathHex, plannedFinalPathBytes: material.plannedFinalPathBytes,
            finalDevice: material.finalDevice, finalInode: material.finalInode, finalBytes: material.finalBytes,
            finalSHA256: material.finalSHA256, status: 4
        )
        return .init(schema: snapshot.schema, reservationID: snapshot.reservationID, ledgerDevice: snapshot.ledgerDevice,
                     ledgerBytes: snapshot.ledgerBytes, materials: materials, volumes: snapshot.volumes)
    }

    private static func receipt(_ material: MaterialRecord, snapshot: Snapshot) -> Receipt {
        let volume = snapshot.volumes.first { $0.device == material.volume }!
        return .init(materialID: material.id, idempotencyKey: material.idempotencyKey, bytes: try! parse(material.actualBytes),
                     remainingBytesOnVolume: try! parse(volume.remainingBytes), dataSHA256: material.sha256)
    }

    private static func adoptedReserve(_ material: MaterialRecord) -> AdoptedReserve {
        .init(materialID: material.id, idempotencyKey: material.idempotencyKey,
              extentURL: URL(fileURLWithPath: material.extentFilePath), capacityBytes: try! parse(material.bytes),
              plannedFinalURL: try! plannedFinalURL(material))
    }

    private static func view(_ snapshot: Snapshot) -> View {
        let materialBytes = snapshot.materials.reduce(0) { $0 + (try! parse($1.bytes)) }
        let remaining = snapshot.volumes.reduce(0) { $0 + (try! parse($1.remainingBytes)) }
        return .init(reservationID: snapshot.reservationID, ledgerBytes: try! parse(snapshot.ledgerBytes), materialBytes: materialBytes,
                     remainingMaterialBytes: remaining, consumedMaterialIDs: Set(snapshot.materials.filter { $0.status == 2 }.map(\.id)),
                     volumeRemainingBytes: Dictionary(uniqueKeysWithValues: snapshot.volumes.map { (try! parseUInt($0.device), try! parse($0.remainingBytes)) }))
    }

    private static func samePlan(_ lhs: Snapshot, _ rhs: Snapshot) -> Bool {
        guard lhs.schema == rhs.schema, lhs.reservationID == rhs.reservationID,
              lhs.ledgerDevice == rhs.ledgerDevice, lhs.ledgerBytes == rhs.ledgerBytes else { return false }
        let normalizedMaterials = lhs.materials.map {
            MaterialRecord(id: $0.id, idempotencyKey: $0.idempotencyKey, kind: $0.kind,
                           bytes: $0.bytes, actualBytes: fixed(0), expectedSHA256: $0.expectedSHA256,
                           sha256: zeroDigest, volume: $0.volume, extentFilePath: $0.extentFilePath,
                           plannedFinalPathHex: emptyPathHex, plannedFinalPathBytes: fixed(0),
                           finalDevice: fixed(0), finalInode: fixed(0), finalBytes: fixed(0), finalSHA256: zeroDigest, status: 0)
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
        if bytes == 0 {
            guard fsync(descriptor) == 0, close(descriptor) == 0 else { throw LedgerError.preallocationFailed(volume: device, errno: errno) }
            return
        }
        var allocation = fstore_t(fst_flags: UInt32(F_ALLOCATEALL), fst_posmode: Int32(F_PEOFPOSMODE), fst_offset: 0, fst_length: off_t(bytes), fst_bytesalloc: 0)
        guard fcntl(descriptor, F_PREALLOCATE, &allocation) != -1, allocation.fst_bytesalloc >= bytes,
              ftruncate(descriptor, off_t(bytes)) == 0, fsync(descriptor) == 0 else {
            let value = errno; close(descriptor); try? FileManager.default.removeItem(at: url)
            throw LedgerError.preallocationFailed(volume: device, errno: value)
        }
        guard close(descriptor) == 0 else { throw LedgerError.preallocationFailed(volume: device, errno: errno) }
    }

    private static func requireExtent(_ url: URL, device: UInt64, size: Int) throws {
        let descriptor = open(url.path, O_RDWR | O_CLOEXEC | O_NOFOLLOW)
        guard descriptor >= 0 else { throw LedgerError.physicalReservationNotConverged(volume: device) }
        defer { close(descriptor) }
        var info = stat()
        guard fstat(descriptor, &info) == 0, UInt64(info.st_dev) == device, Int(info.st_size) == size else {
            throw LedgerError.physicalReservationNotConverged(volume: device)
        }
    }

    private static func resizeAndSync(_ url: URL, bytes: Int, expectedDevice: UInt64? = nil) throws {
        let descriptor = open(url.path, O_RDWR | O_CLOEXEC | O_NOFOLLOW)
        guard descriptor >= 0 else { throw LedgerError.durableWriteFailed("extent open: \(errno)") }
        defer { close(descriptor) }
        var info = stat()
        guard fstat(descriptor, &info) == 0,
              expectedDevice == nil || UInt64(info.st_dev) == expectedDevice,
              ftruncate(descriptor, off_t(bytes)) == 0, fsync(descriptor) == 0 else {
            throw LedgerError.durableWriteFailed("extent resize: \(errno)")
        }
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

    private static func canonicalPlannedFinal(_ url: URL) throws -> URL {
        let parent = url.deletingLastPathComponent().standardizedFileURL.resolvingSymlinksInPath()
        _ = try device(ofExistingDirectory: parent)
        let leaf = url.lastPathComponent
        guard !leaf.isEmpty, leaf != ".", leaf != ".." else { throw LedgerError.finalPathMismatch(url.path) }
        return parent.appendingPathComponent(leaf).standardizedFileURL
    }

    private static func encodePath(_ path: String) throws -> (hex: String, bytes: String) {
        let data = Data(path.utf8)
        guard data.count <= maximumPathBytes else { throw LedgerError.finalPathMismatch(path) }
        let hex = data.map { String(format: "%02x", $0) }.joined()
        return (hex + String(repeating: "0", count: maximumPathBytes * 2 - hex.count), fixed(data.count))
    }

    private static func plannedFinalURL(_ material: MaterialRecord) throws -> URL {
        let count = try parse(material.plannedFinalPathBytes)
        guard count > 0, material.plannedFinalPathHex.count == maximumPathBytes * 2 else { throw LedgerError.finalPathMismatch(material.id) }
        var data = Data(); data.reserveCapacity(count)
        let prefix = material.plannedFinalPathHex.prefix(count * 2)
        var index = prefix.startIndex
        for _ in 0..<count {
            let next = prefix.index(index, offsetBy: 2)
            guard let byte = UInt8(prefix[index..<next], radix: 16) else { throw LedgerError.corruptLedger("invalid planned path") }
            data.append(byte); index = next
        }
        guard let path = String(data: data, encoding: .utf8) else { throw LedgerError.corruptLedger("planned path is not UTF-8") }
        return URL(fileURLWithPath: path)
    }

    private static func inspectMaterialized(_ url: URL, expectedDevice: UInt64, expectedBytes: Int, expectedSHA: String) throws -> MaterialIdentity {
        var info = stat()
        guard lstat(url.path, &info) == 0, (info.st_mode & S_IFMT) == S_IFREG,
              UInt64(info.st_dev) == expectedDevice, Int(info.st_size) == expectedBytes else {
            throw LedgerError.materializationIncomplete(url.path)
        }
        let digest = sha256(try Data(contentsOf: url, options: [.mappedIfSafe]))
        guard digest == expectedSHA else { throw LedgerError.contentMismatch(url.path) }
        return .init(device: UInt64(info.st_dev), inode: UInt64(info.st_ino), bytes: Int(info.st_size), sha256: digest)
    }

    private static func validateStoredIdentity(_ material: MaterialRecord, identity: MaterialIdentity) throws {
        guard try parseUInt(material.finalDevice) == identity.device,
              try parseUInt(material.finalInode) == identity.inode,
              try parse(material.finalBytes) == identity.bytes,
              material.finalSHA256 == identity.sha256 else { throw LedgerError.materializationIncomplete(material.id) }
    }

    private static func materializationReceipt(_ material: MaterialRecord, identity: MaterialIdentity) -> MaterializationReceipt {
        .init(materialID: material.id, idempotencyKey: material.idempotencyKey,
              finalURL: try! plannedFinalURL(material), device: identity.device, inode: identity.inode,
              bytes: identity.bytes, sha256: identity.sha256)
    }

    private static func encode(_ snapshot: Snapshot) throws -> Data {
        let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        return try encoder.encode(snapshot)
    }
    private static let zeroDigest = String(repeating: "0", count: 64)
    private static let emptyPathHex = String(repeating: "0", count: maximumPathBytes * 2)
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
