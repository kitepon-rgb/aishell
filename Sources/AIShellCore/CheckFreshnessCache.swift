import CryptoKit
import Darwin
import Foundation

/// ADR 0011/0018 の cache ownership seam。
/// invocation、step順、selection digest は呼び出し側が解決したものを一切変更せずに受け取る。
public actor CheckFreshnessCache {
    public enum Policy: String, Sendable { case off, prefer, only, refresh }
    public enum TerminalState: String, Codable, Sendable {
        case passed, failed, timedOut = "timed_out", cancelled, signaled, launchFailed = "launch_failed", artifactFailed = "artifact_failed"
        fileprivate var isCacheable: Bool { self == .passed || self == .failed }
    }
    public enum State: String, Sendable { case disabled, hit, missExecuted = "miss_executed", refreshExecuted = "refresh_executed" }
    enum PublicationFailure: Sendable { case quota, store }
    public enum Error: Swift.Error, Equatable, Sendable {
        case cacheMiss, cacheExpired, cacheCorrupt, cacheConflict, cacheQuotaExceeded, cacheStoreFailed, contentChanged, invalidRequest
    }

    public struct Plan: Equatable, Sendable {
        public let invocationID: String
        public let orderedStepIDs: [String]
        public let selectionDigest: String
        public init(invocationID: String, orderedStepIDs: [String], selectionDigest: String) {
            self.invocationID = invocationID; self.orderedStepIDs = orderedStepIDs; self.selectionDigest = selectionDigest
        }
    }
    /// canonical binding material のSHA-256。secret平文はここへ渡さない。
    public struct Step: Equatable, Sendable {
        public let id: String
        public let bindingDigest: String
        public init(id: String, bindingDigest: String) { self.id = id; self.bindingDigest = bindingDigest }
    }
    public struct Request: Equatable, Sendable {
        public let policy: Policy
        public let plan: Plan
        public let orderedSteps: [Step]
        public init(policy: Policy, plan: Plan, orderedSteps: [Step]) {
            self.policy = policy; self.plan = plan; self.orderedSteps = orderedSteps
        }
    }
    public struct Artifact: Codable, Equatable, Sendable {
        public let path: String
        public let sizeBytes: Int
        public let sha256: String
        public let expiresAt: Date
        public init(path: String, sizeBytes: Int, sha256: String, expiresAt: Date) { self.path = path; self.sizeBytes = sizeBytes; self.sha256 = sha256; self.expiresAt = expiresAt }
    }
    public struct Result: Codable, Equatable, Sendable {
        public let stepID: String
        public let terminalState: TerminalState
        public let sourceRunID: String
        public let stdoutArtifactSHA256: String
        public let stderrArtifactSHA256: String
        public let payloadDigest: String
        public let artifacts: [Artifact]
        public init(stepID: String, terminalState: TerminalState, sourceRunID: String, stdoutArtifactSHA256: String, stderrArtifactSHA256: String, payloadDigest: String, artifacts: [Artifact] = []) {
            self.stepID = stepID; self.terminalState = terminalState; self.sourceRunID = sourceRunID
            self.stdoutArtifactSHA256 = stdoutArtifactSHA256; self.stderrArtifactSHA256 = stderrArtifactSHA256; self.payloadDigest = payloadDigest; self.artifacts = artifacts
        }
    }
    public struct Outcome: Equatable, Sendable {
        public let state: State
        public let plan: Plan
        public let results: [Result]
        public let processesStarted: Int
        public let publications: Int
        fileprivate init(state: State, plan: Plan, results: [Result], processesStarted: Int, publications: Int) {
            self.state = state; self.plan = plan; self.results = results
            self.processesStarted = processesStarted; self.publications = publications
        }
    }

    private struct Entry: Codable, Sendable {
        let result: Result
        let expiresAt: Date
        var isComplete: Bool
        var isCorrupt: Bool
    }

    private let ttl: TimeInterval
    private let maximumEntryCount: Int
    private let now: @Sendable () -> Date
    private enum Storage { case memory, directory(URL) }
    private let storage: Storage
    private var didLoadStore = false
    private var entries: [String: [Entry]] = [:]
    private var injectedPublicationFailure: PublicationFailure?

    public init(storeDirectory: URL, ttl: TimeInterval = 600, maximumEntryCount: Int = .max, now: @escaping @Sendable () -> Date = Date.init) {
        self.storage = .directory(storeDirectory)
        self.ttl = max(0, ttl)
        self.maximumEntryCount = max(0, maximumEntryCount)
        self.now = now
    }

    /// 永続化を伴わない明示的なtest adapter。productionでは`init(storeDirectory:)`を使う。
    static func inMemory(ttl: TimeInterval = 600, maximumEntryCount: Int = .max, now: @escaping @Sendable () -> Date = Date.init) -> CheckFreshnessCache {
        CheckFreshnessCache(storage: .memory, ttl: ttl, maximumEntryCount: maximumEntryCount, now: now)
    }
    private init(storage: Storage, ttl: TimeInterval, maximumEntryCount: Int, now: @escaping @Sendable () -> Date) {
        self.storage = storage; self.ttl = max(0, ttl); self.maximumEntryCount = max(0, maximumEntryCount); self.now = now
    }

    /// test seam。file storeではload/persistと整合させる。
    func markEntryCorrupt(for request: Request, stepID: String) throws {
        try validate(request)
        try loadStoreIfNeeded()
        guard let index = request.orderedSteps.firstIndex(where: { $0.id == stepID }) else { throw Error.invalidRequest }
        let key = cacheKey(plan: request.plan, index: index, step: request.orderedSteps[index])
        guard var generations = entries[key], !generations.isEmpty else { throw Error.cacheMiss }
        generations[generations.count - 1].isCorrupt = true
        entries[key] = generations
        try persist(entries)
    }

    /// test seam。incomplete artifact/manifestはhitにしない。
    func markEntryIncomplete(for request: Request, stepID: String) throws {
        try validate(request)
        try loadStoreIfNeeded()
        guard let index = request.orderedSteps.firstIndex(where: { $0.id == stepID }) else { throw Error.invalidRequest }
        let key = cacheKey(plan: request.plan, index: index, step: request.orderedSteps[index])
        guard var generations = entries[key], !generations.isEmpty else { throw Error.cacheMiss }
        generations[generations.count - 1].isComplete = false
        entries[key] = generations
        try persist(entries)
    }

    /// publication failure injectionはatomicity safety net用。実storeではquota/store receiptに接続する。
    func injectPublicationFailure(_ failure: PublicationFailure?) { injectedPublicationFailure = failure }

    public func execute(
        _ request: Request,
        executeUncached: @Sendable ([Step]) async throws -> [Result],
        validateBindingAfterExecution: @Sendable ([Step]) async -> Bool = { _ in true }
    ) async throws -> Outcome {
        try validate(request)
        if request.policy == .off {
            let results = try await executeAndValidate(request, executeUncached: executeUncached)
            return Outcome(state: .disabled, plan: request.plan, results: results, processesStarted: request.orderedSteps.count, publications: 0)
        }
        try loadStoreIfNeeded()

        let keys = request.orderedSteps.enumerated().map { cacheKey(plan: request.plan, index: $0.offset, step: $0.element) }
        let lookupTime = now()
        let observed = try keys.map { try validatedEntry(for: $0, at: lookupTime) }
        if observed.contains(where: { $0?.isCorrupt == true }) { throw Error.cacheCorrupt }
        let completeHit = observed.allSatisfy { entry in
            guard let entry else { return false }
            return entry.isComplete && entry.expiresAt > lookupTime
        }

        switch request.policy {
        case .only:
            guard completeHit else {
                if observed.contains(where: { entry in entry.map { $0.isComplete && $0.expiresAt <= lookupTime } ?? false }) {
                    throw Error.cacheExpired
                }
                throw Error.cacheMiss
            }
            return Outcome(state: .hit, plan: request.plan, results: observed.compactMap { $0?.result }, processesStarted: 0, publications: 0)
        case .prefer where completeHit:
            return Outcome(state: .hit, plan: request.plan, results: observed.compactMap { $0?.result }, processesStarted: 0, publications: 0)
        case .prefer, .refresh:
            let results = try await executeAndValidate(request, executeUncached: executeUncached)
            guard await validateBindingAfterExecution(request.orderedSteps) else { throw Error.contentChanged }
            let publications = try publish(results, for: keys)
            return Outcome(state: request.policy == .refresh ? .refreshExecuted : .missExecuted,
                           plan: request.plan, results: results, processesStarted: request.orderedSteps.count, publications: publications)
        case .off:
            fatalError("offはcache観測前に処理済みです")
        }
    }

    private func publish(_ results: [Result], for keys: [String]) throws -> Int {
        let eligible = zip(keys, results).filter { $0.1.terminalState.isCacheable }
        guard !eligible.isEmpty else { return 0 }
        let publicationTime = now()
        let reusable = eligible.filter { key, result in
            guard let entry = entries[key]?.last else { return false }
            return entry.isComplete && !entry.isCorrupt && entry.expiresAt > publicationTime
                && (entry.result.artifacts.isEmpty || (try? artifactsAreValid(entry.result, at: publicationTime)) == .valid)
                && entry.result.payloadDigest == result.payloadDigest
        }
        guard !eligible.contains(where: { key, result in
            guard let entry = entries[key]?.last, entry.isComplete, !entry.isCorrupt else { return false }
            return entry.result.payloadDigest != result.payloadDigest
        }) else { throw Error.cacheConflict }

        let newEntries = eligible.count - reusable.count
        if let injectedPublicationFailure {
            throw injectedPublicationFailure == .quota ? Error.cacheQuotaExceeded : Error.cacheStoreFailed
        }
        var candidate: [String: [Entry]] = [:]
        for (key, generations) in entries {
            var retained: [Entry] = []
            for entry in generations {
                if entry.isCorrupt { throw Error.cacheCorrupt }
                if !entry.isComplete { continue }
                if entry.expiresAt <= publicationTime { continue }
                if entry.result.artifacts.isEmpty { retained.append(entry); continue }
                switch try artifactsAreValid(entry.result, at: publicationTime) {
                case .valid: retained.append(entry)
                case .expired: continue
                case .corrupt: throw Error.cacheCorrupt
                }
            }
            if !retained.isEmpty { candidate[key] = retained }
        }
        candidate = candidate.filter { !$0.value.isEmpty }
        let currentEntryCount = candidate.values.reduce(0) { $0 + $1.count }
        guard currentEntryCount <= maximumEntryCount, newEntries <= maximumEntryCount - currentEntryCount else { throw Error.cacheQuotaExceeded }

        // 全preflight後にのみappendするため、quota/store/conflictで部分entryを残さない。
        let requestedExpiry = publicationTime.addingTimeInterval(ttl)
        for (key, result) in eligible where !reusable.contains(where: { $0.0 == key && $0.1 == result }) {
            let expiry = result.artifacts.map(\.expiresAt).min().map { min($0, requestedExpiry) } ?? requestedExpiry
            candidate[key, default: []].append(Entry(result: result, expiresAt: expiry, isComplete: true, isCorrupt: false))
        }
        try persist(candidate)
        entries = candidate
        return newEntries
    }

    private struct PersistentEntry: Codable {
        let keyHash: String
        let payloadHash: String
        let entry: Entry
    }
    private struct Manifest: Codable {
        let schema: String
        let entries: [String: [PersistentEntry]]
    }
    private static let manifestSchema = "aishell.check-freshness-cache-manifest.v1"

    private func loadStoreIfNeeded() throws {
        guard !didLoadStore else { return }
        guard case let .directory(directory) = storage else { didLoadStore = true; return }
        let manifestURL = directory.appendingPathComponent("freshness-cache-manifest.json")
        guard FileManager.default.fileExists(atPath: manifestURL.path) else { didLoadStore = true; return }
        let manifest: Manifest
        do { manifest = try JSONDecoder().decode(Manifest.self, from: Data(contentsOf: manifestURL)) }
        catch { throw Error.cacheCorrupt }
        guard manifest.schema == Self.manifestSchema else { throw Error.cacheCorrupt }
        var reloaded: [String: [Entry]] = [:]
        for (key, persistent) in manifest.entries {
            for item in persistent {
                guard item.keyHash == key, item.payloadHash == entryHash(item.entry), try artifactsAreValid(item.entry.result, at: now()) != .corrupt else { throw Error.cacheCorrupt }
            }
            reloaded[key] = persistent.map(\.entry)
        }
        entries = reloaded
        didLoadStore = true
    }

    private enum ArtifactValidation { case valid, expired, corrupt }
    private func validatedEntry(for key: String, at time: Date) throws -> Entry? {
        guard let entry = entries[key]?.last else { return nil }
        guard !entry.isCorrupt else { throw Error.cacheCorrupt }
        if case .directory = storage {
            switch try artifactsAreValid(entry.result, at: time) {
            case .valid: break
            case .expired: return Entry(result: entry.result, expiresAt: .distantPast, isComplete: true, isCorrupt: false)
            case .corrupt: throw Error.cacheCorrupt
            }
        }
        return entry
    }

    private func artifactsAreValid(_ result: Result, at time: Date) throws -> ArtifactValidation {
        guard !result.artifacts.isEmpty else { return .corrupt }
        for artifact in result.artifacts {
            if artifact.expiresAt <= time { return .expired }
            let url = URL(fileURLWithPath: artifact.path)
            if !FileManager.default.fileExists(atPath: url.path) { return .expired }
            guard let data = try? Data(contentsOf: url), data.count == artifact.sizeBytes,
                  SHA256.hash(data: data).map({ String(format: "%02x", $0) }).joined() == artifact.sha256 else { return .corrupt }
        }
        return .valid
    }

    private func entryHash(_ entry: Entry) -> String {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        let data = (try? encoder.encode(entry)) ?? Data()
        return SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }

    private func persist(_ candidate: [String: [Entry]]) throws {
        guard case let .directory(directory) = storage else { return }
        let validationTime = now()
        guard candidate.values.flatMap({ $0 }).allSatisfy({ entry in
            !entry.result.terminalState.isCacheable || artifactInputIsValid(entry.result, at: validationTime)
        }) else {
            throw Error.cacheStoreFailed
        }
        let persistent = candidate.mapValues { generations in
            generations.map { PersistentEntry(keyHash: "", payloadHash: entryHash($0), entry: $0) }
        }
        let withKeys = Dictionary(uniqueKeysWithValues: persistent.map { key, generations in
            (key, generations.map { PersistentEntry(keyHash: key, payloadHash: $0.payloadHash, entry: $0.entry) })
        })
        let data: Data
        do { data = try JSONEncoder().encode(Manifest(schema: Self.manifestSchema, entries: withKeys)) }
        catch { throw Error.cacheStoreFailed }
        do {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            let destination = directory.appendingPathComponent("freshness-cache-manifest.json")
            let temporary = directory.appendingPathComponent(".freshness-cache-\(UUID().uuidString).tmp")
            try durableReplace(data: data, temporary: temporary, destination: destination, directory: directory)
        } catch { throw Error.cacheStoreFailed }
    }

    private func artifactInputIsValid(_ result: Result, at time: Date) -> Bool {
        let artifactHashes = Set(result.artifacts.map(\.sha256))
        return artifactHashes.contains(result.stdoutArtifactSHA256) && artifactHashes.contains(result.stderrArtifactSHA256)
            && !result.artifacts.isEmpty && result.artifacts.allSatisfy { artifact in
            artifact.path.hasPrefix("/") && artifact.sizeBytes >= 0 && isSHA256(artifact.sha256)
                && artifact.expiresAt.timeIntervalSinceReferenceDate.isFinite && artifact.expiresAt > time
        } && (try? artifactsAreValid(result, at: time)) == .valid
    }

    private func durableReplace(data: Data, temporary: URL, destination: URL, directory: URL) throws {
        var descriptor = open(temporary.path, O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC, S_IRUSR | S_IWUSR)
        guard descriptor >= 0 else { throw Error.cacheStoreFailed }
        var shouldRemove = true
        defer {
            if descriptor >= 0 { _ = close(descriptor) }
            if shouldRemove { try? FileManager.default.removeItem(at: temporary) }
        }
        try data.withUnsafeBytes { raw in
            var offset = 0
            while offset < raw.count {
                let written = Darwin.write(descriptor, raw.baseAddress!.advanced(by: offset), raw.count - offset)
                if written > 0 { offset += written; continue }
                if written < 0 && errno == EINTR { continue }
                throw Error.cacheStoreFailed
            }
        }
        guard fsync(descriptor) == 0, close(descriptor) == 0 else { throw Error.cacheStoreFailed }
        descriptor = -1
        let directoryDescriptor = open(directory.path, O_RDONLY | O_DIRECTORY | O_CLOEXEC)
        guard directoryDescriptor >= 0 else { throw Error.cacheStoreFailed }
        defer { _ = close(directoryDescriptor) }
        let renamed = temporary.path.withCString { source in destination.path.withCString { target in Darwin.rename(source, target) } }
        guard renamed == 0, fsync(directoryDescriptor) == 0 else { throw Error.cacheStoreFailed }
        shouldRemove = false
    }

    private func validate(_ request: Request) throws {
        guard !request.plan.invocationID.isEmpty, !request.plan.orderedStepIDs.isEmpty,
              request.plan.orderedStepIDs == request.orderedSteps.map(\.id),
              Set(request.plan.orderedStepIDs).count == request.plan.orderedStepIDs.count,
              isSHA256(request.plan.selectionDigest),
              request.orderedSteps.allSatisfy({ !$0.id.isEmpty && isSHA256($0.bindingDigest) }) else { throw Error.invalidRequest }
    }
    private func executeAndValidate(_ request: Request, executeUncached: @Sendable ([Step]) async throws -> [Result]) async throws -> [Result] {
        let results = try await executeUncached(request.orderedSteps)
        guard results.map(\.stepID) == request.plan.orderedStepIDs,
              results.allSatisfy({ !$0.sourceRunID.isEmpty && isSHA256($0.stdoutArtifactSHA256) && isSHA256($0.stderrArtifactSHA256) && isSHA256($0.payloadDigest) }) else { throw Error.invalidRequest }
        return results
    }
    private func cacheKey(plan: Plan, index: Int, step: Step) -> String {
        // request/invocation identityはfreshness bindingではない。length-prefix framing後のdigestだけを内部keyにする。
        let fields = [plan.selectionDigest, String(index), step.id, step.bindingDigest]
        let canonical = fields.map { "\($0.utf8.count):\($0)" }.joined(separator: "|")
        return SHA256.hash(data: Data(canonical.utf8)).map { String(format: "%02x", $0) }.joined()
    }
    private func isSHA256(_ value: String) -> Bool {
        value.utf8.count == 64 && value.utf8.allSatisfy { (48...57).contains($0) || (97...102).contains($0) }
    }
}
