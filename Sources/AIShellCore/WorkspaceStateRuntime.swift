import CryptoKit
import Darwin
import Foundation

public actor WorkspaceStateRuntime {
    private struct JournalEvent: Sendable {
        let sequence: UInt64
        let path: String
        let eventID: UInt64?
    }

    private struct RootState {
        let root: URL
        let generation: String
        var sequence: UInt64
        var entries: [String: WorkspaceEntry]
        var journal: [JournalEvent]
        var rescanReason: String?
        var observer: FSEventsObserver?
        var lastAccessedAt: Date
    }

    private let runtimeStore: RuntimeStore
    private let startsFSEvents: Bool
    private var states: [String: RootState] = [:]
    private let journalLimit = 10_000
    private let stateLimit = 8
    private var scanInvocationCount = 0

    public init(runtimeStore: RuntimeStore = RuntimeStore(), startsFSEvents: Bool = true) {
        self.runtimeStore = runtimeStore
        self.startsFSEvents = startsFSEvents
    }

    public func snapshot(
        path: String? = nil,
        sinceCursor: String? = nil,
        entryLimit: Int = 500,
        contextBudget: Int = 16_384
    ) async throws -> WorkspaceSnapshot {
        let resolver = try await activeResolver()
        let root = try resolver.resolveExisting(path)
        guard try root.resourceValues(forKeys: [.isDirectoryKey]).isDirectory == true else {
            throw AIShellError.invalidPath(root.path)
        }
        let key = root.path
        let newlyInitialized = states[key] == nil
        if newlyInitialized {
            guard sinceCursor == nil else { throw AIShellError.cursorExpired(sinceCursor!) }
            try await initialize(root: root, key: key)
        }
        guard var state = states[key] else { throw AIShellError.invalidPath(root.path) }
        state.lastAccessedAt = Date()
        states[key] = state
        let limit = min(max(1, entryLimit), 5_000)

        if let sinceCursor {
            let initialCursor = try parseCursor(sinceCursor)
            state.observer?.flush()
            try await Task.sleep(for: .milliseconds(200))
            guard let refreshed = states[key] else { throw AIShellError.invalidPath(root.path) }
            state = refreshed
            if let reason = state.rescanReason { throw AIShellError.rescanRequired(reason) }
            let parsed = initialCursor
            guard parsed.generation == state.generation, parsed.sequence <= state.sequence else {
                throw AIShellError.cursorExpired(sinceCursor)
            }
            if let first = state.journal.first, parsed.sequence + 1 < first.sequence {
                throw AIShellError.cursorExpired(sinceCursor)
            }
            let pendingEvents = state.journal.filter { $0.sequence > parsed.sequence }
            var uniqueEvents: [(path: String, sequence: UInt64)] = []
            for event in pendingEvents where !uniqueEvents.contains(where: { $0.path == event.path }) {
                uniqueEvents.append((event.path, event.sequence))
            }
            var observedPaths = uniqueEvents.prefix(limit).map(\.path)
            var expanded = true
            while expanded, observedPaths.count < uniqueEvents.count {
                expanded = false
                for selectedPath in observedPaths {
                    let remainder = uniqueEvents.dropFirst(observedPaths.count)
                    if let pairIndex = try remainder.firstIndex(where: {
                        try formsRenamePair(selectedPath, $0.path, state: state)
                    }) {
                        observedPaths = uniqueEvents.prefix(pairIndex + 1).map(\.path)
                        expanded = true
                        break
                    }
                }
            }
            let selected = Set(observedPaths)
            var processedSequence = parsed.sequence
            for event in pendingEvents {
                guard selected.contains(event.path) else { break }
                processedSequence = event.sequence
            }
            let changes = try reconcile(paths: observedPaths, state: &state)
            states[key] = state
            let changedEntries = changes.compactMap(\.entry)
            let remainingPaths = Set(pendingEvents.filter { $0.sequence > processedSequence }.map(\.path))
            let git = try gitStatus(root: root)
            return WorkspaceSnapshot(
                schemaVersion: "aishell.workspace-snapshot.v1",
                root: root.path,
                cursor: cursor(for: state, sequence: processedSequence),
                isFull: false,
                freshness: "fresh",
                entries: [],
                changes: changes,
                omittedEntries: remainingPaths.count,
                manifests: Array(manifestPaths(in: state.entries).prefix(100)),
                guidanceFiles: Array(guidancePaths(in: state.entries).prefix(100)),
                testCandidates: testPaths(in: state.entries),
                gitStatusState: git.state,
                gitStatus: git.lines,
                context: try contextChunks(
                    root: root,
                    candidates: changedEntries,
                    budget: contextBudget
                )
            )
        }

        if !newlyInitialized {
            state.entries = try scan(root: root)
        }
        state.rescanReason = nil
        states[key] = state
        let sorted = state.entries.values.sorted { $0.path < $1.path }
        let visible = Array(sorted.prefix(limit))
        let git = try gitStatus(root: root)
        return WorkspaceSnapshot(
            schemaVersion: "aishell.workspace-snapshot.v1",
            root: root.path,
            cursor: cursor(for: state),
            isFull: true,
            freshness: "fresh",
            entries: visible,
            changes: [],
            omittedEntries: sorted.count - visible.count,
            manifests: Array(manifestPaths(in: state.entries).prefix(100)),
            guidanceFiles: Array(guidancePaths(in: state.entries).prefix(100)),
            testCandidates: testPaths(in: state.entries),
            gitStatusState: git.state,
            gitStatus: git.lines,
            context: try contextChunks(
                root: root,
                candidates: prioritizedContextEntries(in: state.entries),
                budget: contextBudget
            )
        )
    }

    func ingestObservedPaths(_ paths: [String]) {
        ingest(paths.map { ObservedFileEvent(path: $0, eventID: 0, flags: 0) })
    }

    func markRescanRequired(reason: String) {
        for key in states.keys {
            states[key]?.rescanReason = reason
        }
    }

    public func recentChangedPaths() -> [String] {
        var result: [String] = []
        for state in states.values {
            for event in state.journal.suffix(500) where !result.contains(event.path) {
                result.append(event.path)
            }
        }
        return result
    }

    func scanInvocationCountForTests() -> Int { scanInvocationCount }

    private func initialize(root: URL, key: String) async throws {
        if states.count >= stateLimit,
           let oldest = states.min(by: { $0.value.lastAccessedAt < $1.value.lastAccessedAt })?.key {
            states.removeValue(forKey: oldest)
        }
        states[key] = RootState(
            root: root,
            generation: UUID().uuidString.lowercased(),
            sequence: 0,
            entries: [:],
            journal: [],
            rescanReason: nil,
            observer: nil,
            lastAccessedAt: Date()
        )
        if startsFSEvents {
            let observer = try FSEventsObserver(path: root.path) { [weak self] events in
                Task { await self?.ingest(events) }
            }
            states[key]?.observer = observer
            observer.flush()
            try await Task.sleep(for: .milliseconds(250))
            guard var warmed = states[key] else { throw AIShellError.invalidPath(root.path) }
            warmed.journal.removeAll(keepingCapacity: true)
            states[key] = warmed
        }
        let scannedEntries = try scan(root: root)
        if startsFSEvents {
            states[key]?.observer?.flush()
            try await Task.sleep(for: .milliseconds(50))
        }
        guard var scanned = states[key] else { throw AIShellError.invalidPath(root.path) }
        scanned.entries = scannedEntries
        let observedDuringScan = scanned.journal.map(\.path)
        if !observedDuringScan.isEmpty {
            _ = try reconcile(paths: observedDuringScan, state: &scanned)
        }
        states[key] = scanned
    }

    private func ingest(_ events: [ObservedFileEvent]) {
        for key in Array(states.keys) {
            guard var state = states[key] else { continue }
            for event in events where Self.contains(event.path, in: state.root.path) {
                if event.requiresRescan {
                    state.rescanReason = "FSEvents gap/root change (flags=\(event.flags), id=\(event.eventID))"
                }
                state.sequence &+= 1
                state.journal.append(JournalEvent(
                    sequence: state.sequence,
                    path: event.path,
                    eventID: event.eventID
                ))
            }
            if state.journal.count > journalLimit {
                state.journal.removeFirst(state.journal.count - journalLimit)
            }
            states[key] = state
        }
    }

    private func reconcile(paths: [String], state: inout RootState) throws -> [WorkspaceChange] {
        let reconciliationPaths = try expandedObservedPaths(paths, state: state)
        guard reconciliationPaths.count <= 5_000 else {
            throw AIShellError.rescanRequired("directory subtree change exceeds 5000 entries")
        }
        var changes: [WorkspaceChange] = []
        var deletedByIdentity: [String: (String, WorkspaceEntry)] = [:]
        for absolutePath in reconciliationPaths {
            let url = URL(fileURLWithPath: absolutePath).standardizedFileURL
            let relative = Self.relativePath(url.path, root: state.root.path)
            guard !relative.isEmpty, !Self.isExcluded(relative) else { continue }
            let previous = state.entries[relative]
            let current = try currentEntry(url: url, root: state.root)
            switch (previous, current) {
            case let (old?, nil):
                state.entries.removeValue(forKey: relative)
                deletedByIdentity[old.identity] = (relative, old)
                changes.append(WorkspaceChange(kind: .deleted, path: relative, previousPath: nil, entry: nil))
            case let (nil, new?):
                state.entries[relative] = new
                changes.append(WorkspaceChange(kind: .created, path: relative, previousPath: nil, entry: new))
            case let (old?, new?) where old != new:
                state.entries[relative] = new
                changes.append(WorkspaceChange(kind: .modified, path: relative, previousPath: nil, entry: new))
            default:
                break
            }
        }

        var consumedDeletedPaths = Set<String>()
        let transformed = changes.map { change -> WorkspaceChange in
            guard change.kind == .created,
                  let entry = change.entry,
                  let deleted = deletedByIdentity[entry.identity] else { return change }
            consumedDeletedPaths.insert(deleted.0)
            return WorkspaceChange(
                kind: .renamed,
                path: change.path,
                previousPath: deleted.0,
                entry: entry
            )
        }
        return transformed.filter {
            !($0.kind == .deleted && consumedDeletedPaths.contains($0.path))
        }.sorted { $0.path < $1.path }
    }

    private func expandedObservedPaths(_ paths: [String], state: RootState) throws -> [String] {
        var expanded: [String] = []
        func append(_ path: String) {
            if !expanded.contains(path) { expanded.append(path) }
        }
        for absolutePath in paths {
            append(absolutePath)
            let url = URL(fileURLWithPath: absolutePath).standardizedFileURL
            let relative = Self.relativePath(url.path, root: state.root.path)
            for oldPath in state.entries.keys where oldPath.hasPrefix(relative + "/") {
                append(state.root.appendingPathComponent(oldPath).path)
            }
            guard FileManager.default.fileExists(atPath: url.path),
                  try url.resourceValues(forKeys: [.isDirectoryKey]).isDirectory == true else { continue }
            var traversalError: Error?
            guard let enumerator = FileManager.default.enumerator(
                at: url,
                includingPropertiesForKeys: [.isDirectoryKey],
                options: [],
                errorHandler: { _, error in traversalError = error; return false }
            ) else { continue }
            for case let child as URL in enumerator {
                let childRelative = Self.relativePath(child.path, root: state.root.path)
                if Self.isExcluded(childRelative) {
                    enumerator.skipDescendants()
                    continue
                }
                append(child.path)
            }
            if let traversalError { throw traversalError }
        }
        return expanded
    }

    private func formsRenamePair(_ firstPath: String, _ secondPath: String, state: RootState) throws -> Bool {
        func transition(_ absolutePath: String) throws -> (old: String?, new: String?) {
            let url = URL(fileURLWithPath: absolutePath).standardizedFileURL
            let relative = Self.relativePath(url.path, root: state.root.path)
            return (state.entries[relative]?.identity, try currentEntry(url: url, root: state.root)?.identity)
        }
        let first = try transition(firstPath)
        let second = try transition(secondPath)
        return (first.old != nil && first.new == nil && second.old == nil && second.new == first.old)
            || (second.old != nil && second.new == nil && first.old == nil && first.new == second.old)
    }

    private func scan(root: URL) throws -> [String: WorkspaceEntry] {
        scanInvocationCount += 1
        var entries: [String: WorkspaceEntry] = [:]
        var traversalError: Error?
        guard let enumerator = FileManager.default.enumerator(
            at: root,
            includingPropertiesForKeys: [.isDirectoryKey, .fileSizeKey, .contentModificationDateKey],
            options: [],
            errorHandler: { _, error in
                traversalError = error
                return false
            }
        ) else { return entries }
        for case let url as URL in enumerator {
            let relative = Self.relativePath(url.path, root: root.path)
            if Self.isExcluded(relative) {
                enumerator.skipDescendants()
                continue
            }
            if let entry = try currentEntry(url: url, root: root) {
                entries[relative] = entry
            }
        }
        if let traversalError { throw traversalError }
        return entries
    }

    private func currentEntry(url: URL, root: URL) throws -> WorkspaceEntry? {
        guard FileManager.default.fileExists(atPath: url.path) else { return nil }
        guard Self.contains(url.resolvingSymlinksInPath().path, in: root.resolvingSymlinksInPath().path) else {
            return nil
        }
        let values = try url.resourceValues(forKeys: [
            .isDirectoryKey, .isSymbolicLinkKey, .fileSizeKey, .contentModificationDateKey
        ])
        guard values.isSymbolicLink != true else { return nil }
        let isDirectory = values.isDirectory == true
        var info = stat()
        guard lstat(url.path, &info) == 0 else { return nil }
        let size = Int64(values.fileSize ?? 0)
        let hash: String?
        if !isDirectory, size <= 4 * 1_024 * 1_024 {
            let data = try Data(contentsOf: url, options: .mappedIfSafe)
            hash = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
        } else {
            hash = nil
        }
        return WorkspaceEntry(
            path: Self.relativePath(url.path, root: root.path),
            identity: "\(info.st_dev):\(info.st_ino)",
            isDirectory: isDirectory,
            sizeBytes: size,
            modifiedAt: values.contentModificationDate,
            sha256: hash
        )
    }

    private func activeResolver() async throws -> AllowedPathResolver {
        let configuration = try await runtimeStore.loadConfiguration()
        guard !configuration.isPaused else { throw AIShellError.paused }
        return try AllowedPathResolver(rootPaths: configuration.allowedRootPaths)
    }

    private func cursor(for state: RootState, sequence: UInt64? = nil) -> String {
        "ws1:\(state.generation):\(sequence ?? state.sequence)"
    }

    private func parseCursor(_ cursor: String) throws -> (generation: String, sequence: UInt64) {
        let parts = cursor.split(separator: ":", omittingEmptySubsequences: false)
        guard parts.count == 3, parts[0] == "ws1", let sequence = UInt64(parts[2]) else {
            throw AIShellError.cursorExpired(cursor)
        }
        return (String(parts[1]), sequence)
    }

    private func manifestPaths(in entries: [String: WorkspaceEntry]) -> [String] {
        let names: Set<String> = ["Package.swift", "package.json", "Cargo.toml", "pyproject.toml", "go.mod"]
        return entries.values.filter { names.contains(URL(fileURLWithPath: $0.path).lastPathComponent) }
            .map(\.path).sorted()
    }

    private func guidancePaths(in entries: [String: WorkspaceEntry]) -> [String] {
        entries.values.filter {
            let name = URL(fileURLWithPath: $0.path).lastPathComponent
            return name == "AGENTS.md" || name == "CLAUDE.md" || $0.path == "rag/INDEX.md"
        }.map(\.path).sorted()
    }

    private func testPaths(in entries: [String: WorkspaceEntry]) -> [String] {
        entries.values.filter {
            !$0.isDirectory && ($0.path.contains("/Tests/") || $0.path.hasPrefix("Tests/") || $0.path.contains(".test."))
        }.map(\.path).sorted().prefix(100).map { $0 }
    }

    private func prioritizedContextEntries(in entries: [String: WorkspaceEntry]) -> [WorkspaceEntry] {
        entries.values.filter { !$0.isDirectory }.sorted {
            let left = contextPriority($0.path)
            let right = contextPriority($1.path)
            if left != right { return left < right }
            return $0.path < $1.path
        }
    }

    private func contextPriority(_ path: String) -> Int {
        let name = URL(fileURLWithPath: path).lastPathComponent
        if name == "AGENTS.md" || name == "CLAUDE.md" || path == "rag/INDEX.md" { return 0 }
        if ["Package.swift", "package.json", "Cargo.toml", "pyproject.toml", "go.mod"].contains(name) { return 1 }
        if path.contains("/Tests/") || path.hasPrefix("Tests/") || path.contains(".test.") { return 2 }
        return 3
    }

    private func contextChunks(
        root: URL,
        candidates: [WorkspaceEntry],
        budget: Int
    ) throws -> [ContextChunk] {
        let limit = min(max(0, budget), 65_536)
        guard limit > 0 else { return [] }
        var remaining = limit
        var chunks: [ContextChunk] = []
        for entry in candidates where remaining > 0 && entry.sizeBytes <= 65_536 {
            let url = root.appendingPathComponent(entry.path)
            guard let data = try? Data(contentsOf: url, options: .mappedIfSafe),
                  String(data: data, encoding: .utf8) != nil else { continue }
            guard data.count <= remaining else { continue }
            chunks.append(ContextChunk(
                path: entry.path,
                text: String(decoding: data, as: UTF8.self),
                sha256: entry.sha256 ?? SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined(),
                sizeBytes: data.count,
                returnedBytes: data.count,
                omittedBytes: 0
            ))
            remaining -= data.count
        }
        return chunks
    }

    private func gitStatus(root: URL) throws -> (state: String, lines: [String]) {
        let git = URL(fileURLWithPath: "/usr/bin/git")
        guard FileManager.default.isExecutableFile(atPath: git.path),
              FileManager.default.fileExists(atPath: root.appendingPathComponent(".git").path)
        else { return ("not_repository", []) }
        let scratch = FileManager.default.temporaryDirectory
            .appendingPathComponent("AIShellGit-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: scratch, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: scratch) }
        let outputURL = scratch.appendingPathComponent("stdout")
        let errorURL = scratch.appendingPathComponent("stderr")
        FileManager.default.createFile(atPath: outputURL.path, contents: nil)
        FileManager.default.createFile(atPath: errorURL.path, contents: nil)
        let output = try FileHandle(forWritingTo: outputURL)
        let error = try FileHandle(forWritingTo: errorURL)
        let process = Process()
        process.executableURL = git
        process.arguments = ["--no-optional-locks", "-C", root.path, "status", "--short", "--untracked-files=normal"]
        process.environment = ProcessInfo.processInfo.environment.merging(["GIT_OPTIONAL_LOCKS": "0"]) { _, value in value }
        process.standardOutput = output
        process.standardError = error
        try process.run()
        process.waitUntilExit()
        try output.close()
        try error.close()
        guard process.terminationStatus == 0 else {
            let message = String(decoding: try Data(contentsOf: errorURL), as: UTF8.self)
            throw AIShellError.processLaunchFailed("git status exit \(process.terminationStatus): \(message)")
        }
        let data = try Data(contentsOf: outputURL, options: .mappedIfSafe)
        let lines = String(decoding: data, as: UTF8.self)
            .split(whereSeparator: { $0.isNewline }).prefix(500).map(String.init)
        return (lines.isEmpty ? "clean" : "dirty", lines)
    }

    private static func isExcluded(_ relative: String) -> Bool {
        let components = relative.split(separator: "/")
        return components.contains { [".git", ".build", "node_modules"].contains(String($0)) }
    }

    private static func relativePath(_ path: String, root: String) -> String {
        let targetComponents = canonicalPath(path).pathComponents
        let rootComponents = canonicalPath(root).pathComponents
        guard targetComponents.count >= rootComponents.count,
              Array(targetComponents.prefix(rootComponents.count)) == rootComponents else {
            return path
        }
        return targetComponents.dropFirst(rootComponents.count).joined(separator: "/")
    }

    private static func contains(_ path: String, in root: String) -> Bool {
        let target = canonicalPath(path).path
        let boundary = canonicalPath(root).path
        return target == boundary || target.hasPrefix(boundary + "/")
    }

    private static func canonicalPath(_ path: String) -> URL {
        URL(fileURLWithPath: path).standardizedFileURL.resolvingSymlinksInPath()
    }
}
