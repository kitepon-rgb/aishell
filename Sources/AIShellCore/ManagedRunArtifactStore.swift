import CryptoKit
import Darwin
import Foundation

public enum ManagedRunArtifactStoreError: Error, Equatable, Sendable {
    case bindingMismatch
    case runNotFinalized
    case artifactNotFound
    case storeCorrupt(String)
}

public struct ManagedRunArtifactRecord: Codable, Equatable, Sendable {
    public let schema: String
    public let runID: UUID
    public let requestDigest: String
    public let stdout: ManagedArtifactIdentity
    public let stderr: ManagedArtifactIdentity
    public let diagnostics: ManagedArtifactIdentity
    public let finalizedAt: Date

    public init(
        runID: UUID,
        requestDigest: String,
        stdout: ManagedArtifactIdentity,
        stderr: ManagedArtifactIdentity,
        diagnostics: ManagedArtifactIdentity,
        finalizedAt: Date
    ) {
        schema = "aishell.managed-run-index.v1"
        self.runID = runID
        self.requestDigest = requestDigest
        self.stdout = stdout
        self.stderr = stderr
        self.diagnostics = diagnostics
        self.finalizedAt = finalizedAt
    }
}

/// managed runの3 artifactとrun indexを、一つのdirectory renameで同時公開する。
/// stagingは公開検索面から見えず、再試行は同じbindingだけを冪等に受理する。
public actor ManagedRunArtifactStore: ManagedSpoolFinalizationSeam {
    public static let storageSchema = "aishell.managed-run-index.v1"

    private let publicRootURL: URL
    private let stagingRootURL: URL
    private var pending: PendingPublication?

    public init(runtimeStore: RuntimeStore = RuntimeStore()) throws {
        let root = runtimeStore.baseDirectory
            .appendingPathComponent("managed-runs", isDirectory: true)
            .appendingPathComponent("artifacts", isDirectory: true)
        publicRootURL = root.appendingPathComponent("published", isDirectory: true)
        stagingRootURL = root.appendingPathComponent("staging", isDirectory: true)
        try Self.ensurePrivateDirectory(publicRootURL)
        try Self.ensurePrivateDirectory(stagingRootURL)
    }

    public func prepare(
        runID: UUID,
        requestDigest: String,
        stdoutURL: URL,
        stderrURL: URL,
        diagnosticURL: URL
    ) {
        pending = PendingPublication(
            runID: runID,
            requestDigest: requestDigest,
            stdoutURL: stdoutURL,
            stderrURL: stderrURL,
            diagnosticURL: diagnosticURL
        )
    }

    public func fsyncAndInspect(stdoutURL: URL, stderrURL: URL) throws -> ManagedSpoolInspection {
        guard let pending, pending.stdoutURL == stdoutURL, pending.stderrURL == stderrURL else {
            throw ManagedRunArtifactStoreError.bindingMismatch
        }
        return ManagedSpoolInspection(
            stdout: try Self.inspect(
                stdoutURL,
                handle: Self.artifactHandle(runID: pending.runID, channel: "stdout")
            ),
            stderr: try Self.inspect(
                stderrURL,
                handle: Self.artifactHandle(runID: pending.runID, channel: "stderr")
            )
        )
    }

    public func publishAtomically(
        inspection: ManagedSpoolInspection,
        diagnostics: ManagedArtifactIdentity,
        finalizedAt: Date
    ) throws -> ManagedFinalizationBundle {
        guard let pending else { throw ManagedRunArtifactStoreError.bindingMismatch }
        let publishedURL = publicRunURL(pending.runID)
        let record = ManagedRunArtifactRecord(
            runID: pending.runID,
            requestDigest: pending.requestDigest,
            stdout: inspection.stdout,
            stderr: inspection.stderr,
            diagnostics: diagnostics,
            finalizedAt: finalizedAt
        )
        if FileManager.default.fileExists(atPath: publishedURL.path) {
            let existing = try loadRecord(runID: pending.runID)
            guard existing == record else { throw ManagedRunArtifactStoreError.bindingMismatch }
            return Self.bundle(record)
        }

        let stagingURL = stagingRootURL.appendingPathComponent(
            pending.runID.uuidString.lowercased(), isDirectory: true
        )
        if FileManager.default.fileExists(atPath: stagingURL.path) {
            try FileManager.default.removeItem(at: stagingURL)
        }
        try Self.ensurePrivateDirectory(stagingURL)
        do {
            try Self.copyAndSync(pending.stdoutURL, to: stagingURL.appendingPathComponent("stdout.artifact"))
            try Self.copyAndSync(pending.stderrURL, to: stagingURL.appendingPathComponent("stderr.artifact"))
            let diagnosticData = try Data(contentsOf: pending.diagnosticURL, options: .mappedIfSafe)
            guard UInt64(diagnosticData.count) == diagnostics.sizeBytes,
                  Self.digest(diagnosticData) == diagnostics.sha256 else {
                throw ManagedRunArtifactStoreError.bindingMismatch
            }
            try Self.writeAndSync(diagnosticData, to: stagingURL.appendingPathComponent("diagnostic.artifact"))
            try Self.writeAndSync(
                try Self.encoder.encode(record),
                to: stagingURL.appendingPathComponent("registry-index.json")
            )
            try Self.fsyncDirectory(stagingURL)
            try FileManager.default.moveItem(at: stagingURL, to: publishedURL)
            try Self.fsyncDirectory(publicRootURL)
        } catch {
            if FileManager.default.fileExists(atPath: publishedURL.path) {
                try? FileManager.default.removeItem(at: publishedURL)
                try? Self.fsyncDirectory(publicRootURL)
            }
            try? FileManager.default.removeItem(at: stagingURL)
            throw error
        }
        return Self.bundle(record)
    }

    public func loadRecord(runID: UUID) throws -> ManagedRunArtifactRecord {
        let runURL = publicRunURL(runID)
        guard FileManager.default.fileExists(atPath: runURL.path) else {
            throw ManagedRunArtifactStoreError.runNotFinalized
        }
        let record = try Self.decoder.decode(
            ManagedRunArtifactRecord.self,
            from: Data(contentsOf: runURL.appendingPathComponent("registry-index.json"))
        )
        guard record.schema == Self.storageSchema, record.runID == runID else {
            throw ManagedRunArtifactStoreError.storeCorrupt("run index binding")
        }
        try verify(record, in: runURL)
        return record
    }

    public func artifact(handle: String) throws -> ArtifactQueryService.Artifact {
        let directories = try FileManager.default.contentsOfDirectory(
            at: publicRootURL, includingPropertiesForKeys: [.isDirectoryKey], options: [.skipsHiddenFiles]
        ).sorted { $0.lastPathComponent < $1.lastPathComponent }
        for directory in directories {
            guard let runID = UUID(uuidString: directory.lastPathComponent) else { continue }
            let record = try loadRecord(runID: runID)
            for (identity, name, kind) in [
                (record.stdout, "stdout.artifact", "stdout"),
                (record.stderr, "stderr.artifact", "stderr"),
                (record.diagnostics, "diagnostic.artifact", "diagnostic")
            ] where identity.handle == handle {
                return ArtifactQueryService.Artifact(
                    id: handle,
                    kind: kind,
                    data: try Data(contentsOf: directory.appendingPathComponent(name), options: .mappedIfSafe)
                )
            }
        }
        throw ManagedRunArtifactStoreError.artifactNotFound
    }

    public func artifacts(runID: UUID, channels: Set<String> = ["stdout", "stderr"]) throws -> [ArtifactQueryService.Artifact] {
        let record = try loadRecord(runID: runID)
        let directory = publicRunURL(runID)
        var result: [ArtifactQueryService.Artifact] = []
        if channels.contains("stdout") {
            result.append(.init(id: record.stdout.handle, kind: "stdout", data: try Data(
                contentsOf: directory.appendingPathComponent("stdout.artifact"), options: .mappedIfSafe
            )))
        }
        if channels.contains("stderr") {
            result.append(.init(id: record.stderr.handle, kind: "stderr", data: try Data(
                contentsOf: directory.appendingPathComponent("stderr.artifact"), options: .mappedIfSafe
            )))
        }
        if channels.contains("diagnostics") {
            result.append(.init(id: record.diagnostics.handle, kind: "diagnostic", data: try Data(
                contentsOf: directory.appendingPathComponent("diagnostic.artifact"), options: .mappedIfSafe
            )))
        }
        return result
    }

    private struct PendingPublication {
        let runID: UUID
        let requestDigest: String
        let stdoutURL: URL
        let stderrURL: URL
        let diagnosticURL: URL
    }

    private func publicRunURL(_ runID: UUID) -> URL {
        publicRootURL.appendingPathComponent(runID.uuidString.lowercased(), isDirectory: true)
    }

    private func verify(_ record: ManagedRunArtifactRecord, in directory: URL) throws {
        for (identity, name) in [
            (record.stdout, "stdout.artifact"),
            (record.stderr, "stderr.artifact"),
            (record.diagnostics, "diagnostic.artifact")
        ] {
            let data = try Data(contentsOf: directory.appendingPathComponent(name), options: .mappedIfSafe)
            guard UInt64(data.count) == identity.sizeBytes, Self.digest(data) == identity.sha256 else {
                throw ManagedRunArtifactStoreError.storeCorrupt("artifact digest")
            }
        }
    }

    private static func bundle(_ record: ManagedRunArtifactRecord) -> ManagedFinalizationBundle {
        ManagedFinalizationBundle(
            stdout: record.stdout,
            stderr: record.stderr,
            diagnostics: record.diagnostics,
            runIndexDigest: digest((try? encoder.encode(record)) ?? Data()),
            finalizedAt: record.finalizedAt
        )
    }

    private static func artifactHandle(runID: UUID, channel: String) -> String {
        "run_\(runID.uuidString.replacingOccurrences(of: "-", with: "").lowercased())_\(channel)"
    }

    private static func inspect(_ url: URL, handle: String) throws -> ManagedArtifactIdentity {
        let file = try FileHandle(forWritingTo: url)
        try file.synchronize()
        try file.close()
        let data = try Data(contentsOf: url, options: .mappedIfSafe)
        return ManagedArtifactIdentity(
            handle: handle,
            sizeBytes: UInt64(data.count),
            lineCount: UInt64(data.reduce(0) { $1 == 0x0a ? $0 + 1 : $0 }),
            sha256: digest(data)
        )
    }

    private static func copyAndSync(_ source: URL, to destination: URL) throws {
        try writeAndSync(try Data(contentsOf: source, options: .mappedIfSafe), to: destination)
    }

    private static func writeAndSync(_ data: Data, to url: URL) throws {
        guard FileManager.default.createFile(
            atPath: url.path, contents: nil, attributes: [.posixPermissions: 0o600]
        ) else { throw ManagedRunArtifactStoreError.storeCorrupt("artifact create") }
        let file = try FileHandle(forWritingTo: url)
        do {
            try file.write(contentsOf: data)
            try file.synchronize()
            try file.close()
        } catch {
            try? file.close()
            throw error
        }
    }

    private static func fsyncDirectory(_ url: URL) throws {
        let descriptor = Darwin.open(url.path, O_RDONLY | O_DIRECTORY | O_CLOEXEC)
        guard descriptor >= 0 else { throw ManagedRunArtifactStoreError.storeCorrupt("directory open") }
        defer { Darwin.close(descriptor) }
        guard Darwin.fsync(descriptor) == 0 else {
            throw ManagedRunArtifactStoreError.storeCorrupt("directory fsync")
        }
    }

    private static func ensurePrivateDirectory(_ url: URL) throws {
        if !FileManager.default.fileExists(atPath: url.path) {
            try FileManager.default.createDirectory(
                at: url, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700]
            )
        }
        try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: url.path)
    }

    private static func digest(_ data: Data) -> String {
        SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }

    private static var encoder: JSONEncoder {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        encoder.dateEncodingStrategy = .millisecondsSince1970
        return encoder
    }

    private static var decoder: JSONDecoder {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .millisecondsSince1970
        return decoder
    }
}
