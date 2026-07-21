import CryptoKit
import Foundation

enum WorkspaceCheckpointEntryKind: String, Codable, Sendable {
    case file
    case directory
}

enum WorkspaceCheckpointHashState: String, Codable, Sendable {
    case hashed
    case deferred
    case notApplicable = "not_applicable"
}

struct WorkspaceCheckpointEntry: Codable, Equatable, Sendable {
    let path: String
    let identity: String
    let kind: WorkspaceCheckpointEntryKind
    let sizeBytes: Int64
    let modifiedAtNanoseconds: Int64?
    let sha256: String?
    let hashState: WorkspaceCheckpointHashState

    enum CodingKeys: String, CodingKey {
        case path, identity, kind, sha256
        case sizeBytes = "size_bytes"
        case modifiedAtNanoseconds = "modified_at_nanoseconds"
        case hashState = "hash_state"
    }
}

struct WorkspaceCheckpoint: Codable, Equatable, Sendable {
    static let currentSchema = "aishell.workspace-checkpoint.v1"

    let schema: String
    let rootPath: String
    let rootIdentity: String
    let rootDigest: String
    let exclusionDigest: String
    let generation: String
    let lastEventID: UInt64?
    let entries: [WorkspaceCheckpointEntry]
    let createdAt: Date
    let lastAccessedAt: Date
    let payloadSHA256: String?

    init(
        schema: String = Self.currentSchema,
        rootPath: String,
        rootIdentity: String,
        rootDigest: String,
        exclusionDigest: String,
        generation: String,
        lastEventID: UInt64?,
        entries: [WorkspaceCheckpointEntry],
        createdAt: Date,
        lastAccessedAt: Date,
        payloadSHA256: String? = nil
    ) {
        self.schema = schema
        self.rootPath = rootPath
        self.rootIdentity = rootIdentity
        self.rootDigest = rootDigest
        self.exclusionDigest = exclusionDigest
        self.generation = generation
        self.lastEventID = lastEventID
        self.entries = entries
        self.createdAt = createdAt
        self.lastAccessedAt = lastAccessedAt
        self.payloadSHA256 = payloadSHA256
    }

    enum CodingKeys: String, CodingKey {
        case schema, generation, entries
        case rootPath = "root_path"
        case rootIdentity = "root_identity"
        case rootDigest = "root_digest"
        case exclusionDigest = "exclusion_digest"
        case lastEventID = "last_event_id"
        case createdAt = "created_at"
        case lastAccessedAt = "last_accessed_at"
        case payloadSHA256 = "payload_sha256"
    }

    func normalized(payloadSHA256: String? = nil) -> WorkspaceCheckpoint {
        WorkspaceCheckpoint(
            schema: schema,
            rootPath: rootPath,
            rootIdentity: rootIdentity,
            rootDigest: rootDigest,
            exclusionDigest: exclusionDigest,
            generation: generation,
            lastEventID: lastEventID,
            entries: entries.sorted { $0.path < $1.path },
            createdAt: createdAt,
            lastAccessedAt: lastAccessedAt,
            payloadSHA256: payloadSHA256
        )
    }
}

struct WorkspaceCheckpointQuota: Sendable {
    var maximumRoots = 8
    var maximumEntriesPerRoot = 500_000
    var maximumBytesPerRoot = 128 * 1_024 * 1_024
    var maximumTotalBytes = 512 * 1_024 * 1_024
}

actor WorkspaceCheckpointStore {
    private let baseDirectory: URL
    private let quota: WorkspaceCheckpointQuota
    private let beforeCommit: (@Sendable () throws -> Void)?
    private let fileManager = FileManager.default

    init(
        baseDirectory: URL,
        quota: WorkspaceCheckpointQuota = WorkspaceCheckpointQuota(),
        beforeCommit: (@Sendable () throws -> Void)? = nil
    ) {
        self.baseDirectory = baseDirectory.appendingPathComponent("workspaces", isDirectory: true)
        self.quota = quota
        self.beforeCommit = beforeCommit
    }

    func load(rootDigest: String) throws -> WorkspaceCheckpoint? {
        let url = try checkpointURL(rootDigest: rootDigest)
        guard fileManager.fileExists(atPath: url.path) else { return nil }
        let data: Data
        do {
            data = try Data(contentsOf: url, options: .mappedIfSafe)
        } catch {
            throw AIShellError.checkpointCorrupt("\(url.path): \(error.localizedDescription)")
        }
        let schema: String
        do {
            let object = try JSONSerialization.jsonObject(with: data)
            guard let dictionary = object as? [String: Any], let value = dictionary["schema"] as? String else {
                throw AIShellError.checkpointCorrupt("schemaがありません: \(url.path)")
            }
            schema = value
        } catch let error as AIShellError {
            throw error
        } catch {
            throw AIShellError.checkpointCorrupt("JSONをdecodeできません: \(url.path)")
        }
        guard schema == WorkspaceCheckpoint.currentSchema else {
            throw AIShellError.checkpointUnsupported(schema)
        }
        let checkpoint: WorkspaceCheckpoint
        do {
            checkpoint = try Self.decoder.decode(WorkspaceCheckpoint.self, from: data)
        } catch {
            throw AIShellError.checkpointCorrupt("schema payloadをdecodeできません: \(url.path)")
        }
        guard checkpoint.rootDigest == rootDigest else {
            throw AIShellError.checkpointCorrupt("directoryとroot_digestが一致しません: \(url.path)")
        }
        guard let storedDigest = checkpoint.payloadSHA256 else {
            throw AIShellError.checkpointCorrupt("payload_sha256がありません: \(url.path)")
        }
        let normalized = checkpoint.normalized()
        let actualDigest = Self.digest(try Self.encoder.encode(normalized))
        guard storedDigest == actualDigest else {
            throw AIShellError.checkpointCorrupt("payload_sha256が一致しません: \(url.path)")
        }
        try Self.validateEntries(checkpoint.entries, path: url.path)
        return checkpoint.normalized(payloadSHA256: storedDigest)
    }

    @discardableResult
    func save(
        _ checkpoint: WorkspaceCheckpoint,
        activeRootDigests: Set<String> = []
    ) throws -> URL {
        guard checkpoint.schema == WorkspaceCheckpoint.currentSchema else {
            throw AIShellError.checkpointUnsupported(checkpoint.schema)
        }
        _ = try checkpointURL(rootDigest: checkpoint.rootDigest)
        try Self.validateEntries(checkpoint.entries, path: checkpoint.rootPath)
        guard checkpoint.entries.count <= quota.maximumEntriesPerRoot else {
            throw AIShellError.checkpointQuotaExceeded(quota.maximumBytesPerRoot)
        }
        let withoutDigest = checkpoint.normalized()
        let digest = Self.digest(try Self.encoder.encode(withoutDigest))
        let encoded = try Self.encoder.encode(withoutDigest.normalized(payloadSHA256: digest))
        guard encoded.count <= quota.maximumBytesPerRoot else {
            throw AIShellError.checkpointQuotaExceeded(quota.maximumBytesPerRoot)
        }

        try fileManager.createDirectory(at: baseDirectory, withIntermediateDirectories: true)
        try evictIfNeeded(
            incomingRootDigest: checkpoint.rootDigest,
            incomingBytes: encoded.count,
            activeRootDigests: activeRootDigests.union([checkpoint.rootDigest])
        )
        let directory = baseDirectory.appendingPathComponent(checkpoint.rootDigest, isDirectory: true)
        try fileManager.createDirectory(at: directory, withIntermediateDirectories: true)
        let destination = directory.appendingPathComponent("checkpoint.json")
        let temporary = directory.appendingPathComponent("checkpoint.\(UUID().uuidString).tmp")
        do {
            fileManager.createFile(atPath: temporary.path, contents: nil)
            let handle = try FileHandle(forWritingTo: temporary)
            try handle.write(contentsOf: encoded)
            try handle.synchronize()
            try handle.close()
            try beforeCommit?()
            if fileManager.fileExists(atPath: destination.path) {
                _ = try fileManager.replaceItemAt(destination, withItemAt: temporary)
            } else {
                try fileManager.moveItem(at: temporary, to: destination)
            }
            return destination
        } catch {
            try? fileManager.removeItem(at: temporary)
            if let aishellError = error as? AIShellError { throw aishellError }
            throw AIShellError.checkpointWriteFailed(error.localizedDescription)
        }
    }

    private func evictIfNeeded(
        incomingRootDigest: String,
        incomingBytes: Int,
        activeRootDigests: Set<String>
    ) throws {
        let directories = try checkpointDirectories()
        let existingIncomingBytes = try fileSize(
            baseDirectory.appendingPathComponent(incomingRootDigest).appendingPathComponent("checkpoint.json")
        )
        var currentTotal = 0
        for directory in directories {
            currentTotal += try fileSize(directory.appendingPathComponent("checkpoint.json"))
        }
        var total = currentTotal - existingIncomingBytes + incomingBytes
        var rootCount = directories.contains { $0.lastPathComponent == incomingRootDigest }
            ? directories.count : directories.count + 1
        guard total > quota.maximumTotalBytes || rootCount > quota.maximumRoots else { return }

        var candidates: [(URL, Date)] = []
        for directory in directories where !activeRootDigests.contains(directory.lastPathComponent) {
            guard let checkpoint = try? load(rootDigest: directory.lastPathComponent) else { continue }
            candidates.append((directory, checkpoint.lastAccessedAt))
        }
        candidates.sort {
            if $0.1 != $1.1 { return $0.1 < $1.1 }
            return $0.0.lastPathComponent < $1.0.lastPathComponent
        }
        for (directory, _) in candidates
            where total > quota.maximumTotalBytes || rootCount > quota.maximumRoots {
            let bytes = try fileSize(directory.appendingPathComponent("checkpoint.json"))
            try fileManager.removeItem(at: directory)
            total -= bytes
            rootCount -= 1
        }
        guard total <= quota.maximumTotalBytes, rootCount <= quota.maximumRoots else {
            throw AIShellError.checkpointQuotaExceeded(quota.maximumTotalBytes)
        }
    }

    private func checkpointDirectories() throws -> [URL] {
        guard fileManager.fileExists(atPath: baseDirectory.path) else { return [] }
        return try fileManager.contentsOfDirectory(
            at: baseDirectory,
            includingPropertiesForKeys: [.isDirectoryKey],
            options: [.skipsHiddenFiles]
        ).filter { try $0.resourceValues(forKeys: [.isDirectoryKey]).isDirectory == true }
    }

    private func checkpointURL(rootDigest: String) throws -> URL {
        guard rootDigest.count == 64,
              rootDigest.unicodeScalars.allSatisfy({
                  (48...57).contains($0.value) || (97...102).contains($0.value)
              }) else {
            throw AIShellError.invalidArgument("root_digestはlowercase SHA-256である必要があります")
        }
        return baseDirectory.appendingPathComponent(rootDigest, isDirectory: true)
            .appendingPathComponent("checkpoint.json")
    }

    private func fileSize(_ url: URL) throws -> Int {
        guard fileManager.fileExists(atPath: url.path) else { return 0 }
        return try url.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0
    }

    private static func validateEntries(_ entries: [WorkspaceCheckpointEntry], path: String) throws {
        var seen = Set<String>()
        for entry in entries {
            guard !entry.path.isEmpty,
                  !entry.path.hasPrefix("/"),
                  !entry.path.split(separator: "/").contains(".."),
                  seen.insert(entry.path).inserted else {
                throw AIShellError.checkpointCorrupt("不正又は重複したentry path: \(path)")
            }
            switch (entry.kind, entry.hashState, entry.sha256) {
            case (.directory, .notApplicable, nil), (.file, .deferred, nil):
                break
            case let (.file, .hashed, digest?) where digest.count == 64:
                break
            default:
                throw AIShellError.checkpointCorrupt("entry hash invariant違反: \(entry.path)")
            }
        }
    }

    private static func digest(_ data: Data) -> String {
        SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }

    private static let encoder: JSONEncoder = {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        encoder.dateEncodingStrategy = .iso8601
        return encoder
    }()

    private static let decoder: JSONDecoder = {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return decoder
    }()
}
