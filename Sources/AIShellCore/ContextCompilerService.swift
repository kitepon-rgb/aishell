import CryptoKit
import Foundation

public actor ContextCompilerService {
    private let runtimeStore: RuntimeStore
    private let workspaceRuntime: WorkspaceStateRuntime?

    public init(
        runtimeStore: RuntimeStore = RuntimeStore(),
        workspaceRuntime: WorkspaceStateRuntime? = nil
    ) {
        self.runtimeStore = runtimeStore
        self.workspaceRuntime = workspaceRuntime
    }

    public func readContext(
        targets: [String],
        byteBudget: Int = 65_536,
        continuation: String? = nil
    ) async throws -> ReadContextResult {
        guard !targets.isEmpty else {
            throw AIShellError.invalidArgument("targetsは1件以上必要です。")
        }
        let resolver = try await activeResolver()
        let budget = min(max(1, byteBudget), 1_048_576)
        let signature = Self.signature(for: targets)
        let start = try parseContinuation(continuation, signature: signature)
        var chunks: [ContextChunk] = []
        var returned = 0
        var omitted = 0
        var next: String?

        for index in start.index..<targets.count {
            let url = try resolver.resolveExisting(targets[index])
            guard try url.resourceValues(forKeys: [.isDirectoryKey]).isDirectory != true else {
                throw AIShellError.invalidPath(url.path)
            }
            let data = try Data(contentsOf: url, options: .mappedIfSafe)
            guard String(data: data, encoding: .utf8) != nil else {
                throw AIShellError.notTextFile(url.path)
            }
            let contentSHA = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
            if index == start.index,
               start.offset > 0,
               let expectedSHA = start.expectedSHA,
               expectedSHA != contentSHA {
                throw AIShellError.contentChanged(url.path)
            }
            let offset = index == start.index ? min(start.offset, data.count) : 0
            let remainingBudget = budget - returned
            guard remainingBudget > 0 else {
                omitted += data.count - offset
                next = continuationToken(signature: signature, index: index, offset: offset, sha256: contentSHA)
                for remaining in targets.dropFirst(index + 1) {
                    if let remainingURL = try? resolver.resolveExisting(remaining),
                       let size = try? remainingURL.resourceValues(forKeys: [.fileSizeKey]).fileSize {
                        omitted += size
                    }
                }
                break
            }
            if !chunks.isEmpty, data.count - offset > remainingBudget {
                omitted += data.count - offset
                next = continuationToken(signature: signature, index: index, offset: offset, sha256: contentSHA)
                for remaining in targets.dropFirst(index + 1) {
                    if let remainingURL = try? resolver.resolveExisting(remaining),
                       let size = try? remainingURL.resourceValues(forKeys: [.fileSizeKey]).fileSize {
                        omitted += size
                    }
                }
                break
            }
            let maximumCount = min(remainingBudget, data.count - offset)
            let selected = try Self.validUTF8Prefix(data: data, offset: offset, maximumCount: maximumCount)
            let count = selected.count
            let relative = displayPath(url: url, resolver: resolver)
            chunks.append(ContextChunk(
                path: relative,
                text: String(data: selected, encoding: .utf8) ?? "",
                sha256: contentSHA,
                sizeBytes: data.count,
                returnedBytes: selected.count,
                omittedBytes: data.count - offset - selected.count
            ))
            returned += selected.count
            omitted += data.count - offset - selected.count
            if offset + count < data.count {
                next = continuationToken(
                    signature: signature,
                    index: index,
                    offset: offset + count,
                    sha256: contentSHA
                )
                for remaining in targets[(index + 1)...] {
                    if let remainingURL = try? resolver.resolveExisting(remaining),
                       let size = try? remainingURL.resourceValues(forKeys: [.fileSizeKey]).fileSize {
                        omitted += size
                    }
                }
                break
            }
            if returned == budget, index + 1 < targets.count {
                next = continuationToken(signature: signature, index: index + 1, offset: 0, sha256: nil)
                for remaining in targets[(index + 1)...] {
                    if let remainingURL = try? resolver.resolveExisting(remaining),
                       let size = try? remainingURL.resourceValues(forKeys: [.fileSizeKey]).fileSize {
                        omitted += size
                    }
                }
                break
            }
        }

        return ReadContextResult(
            schemaVersion: "aishell.read-context.v1",
            chunks: chunks,
            returnedBytes: returned,
            omittedBytes: omitted,
            continuation: next
        )
    }

    public func searchContext(
        query: String,
        path: String? = nil,
        maxResults: Int = 50,
        byteBudget: Int = 65_536,
        continuation: String? = nil
    ) async throws -> SearchContextResult {
        guard !query.isEmpty else { throw AIShellError.invalidArgument("queryは空にできません。") }
        let resolver = try await activeResolver()
        let root = try resolver.resolveExisting(path)
        guard try root.resourceValues(forKeys: [.isDirectoryKey]).isDirectory == true else {
            throw AIShellError.invalidPath(root.path)
        }
        let executable = try rgExecutable()
        let output = try runRG(executable: executable, query: query, root: root)
        let changed = Set(await workspaceRuntime?.recentChangedPaths() ?? [])
        var matches = parseRG(output: output, root: root, changedPaths: changed)
        matches.sort {
            if $0.score != $1.score { return $0.score > $1.score }
            if $0.path != $1.path { return $0.path < $1.path }
            return $0.line < $1.line
        }
        let resultDigest = Self.searchResultDigest(matches)
        let searchSignature = Self.signature(for: [query, root.path])
        let startIndex = try parseSearchContinuation(
            continuation,
            signature: searchSignature,
            resultDigest: resultDigest
        )
        guard startIndex <= matches.count else { throw AIShellError.cursorExpired(continuation ?? "") }

        let resultLimit = min(max(1, maxResults), 500)
        let budget = min(max(1, byteBudget), 1_048_576)
        var visible: [SearchContextMatch] = []
        var used = 0
        for match in matches.dropFirst(startIndex).prefix(resultLimit) {
            let bytes = match.path.utf8.count + match.text.utf8.count + 16
            if used + bytes > budget { break }
            visible.append(match)
            used += bytes
        }
        if visible.isEmpty, startIndex < matches.count {
            throw AIShellError.invalidArgument("byte_budgetが先頭matchより小さすぎます。")
        }
        let nextIndex = startIndex + visible.count
        let remainingBytes = matches.dropFirst(nextIndex).reduce(0) {
            $0 + $1.path.utf8.count + $1.text.utf8.count + 16
        }
        return SearchContextResult(
            schemaVersion: "aishell.search-context.v1",
            query: query,
            worker: "rg --json",
            matches: visible,
            omittedMatches: matches.count - nextIndex,
            returnedBytes: used,
            omittedBytes: remainingBytes,
            continuation: nextIndex < matches.count
                ? searchContinuationToken(
                    signature: searchSignature,
                    index: nextIndex,
                    resultDigest: resultDigest
                ) : nil,
            freshness: "filesystem-current"
        )
    }

    private func activeResolver() async throws -> AllowedPathResolver {
        let configuration = try await runtimeStore.loadConfiguration()
        guard !configuration.isPaused else { throw AIShellError.paused }
        return try AllowedPathResolver(rootPaths: configuration.allowedRootPaths)
    }

    private func parseContinuation(
        _ continuation: String?,
        signature: String
    ) throws -> (index: Int, offset: Int, expectedSHA: String?) {
        guard let continuation else { return (0, 0, nil) }
        let parts = continuation.split(separator: ":", omittingEmptySubsequences: false)
        guard parts.count == 5,
              parts[0] == "read2",
              parts[1] == Substring(signature),
              let index = Int(parts[2]), index >= 0,
              let offset = Int(parts[3]), offset >= 0,
              parts[4].isEmpty || parts[4].count == 64 else {
            throw AIShellError.cursorExpired(continuation)
        }
        return (index, offset, parts[4].isEmpty ? nil : String(parts[4]))
    }

    private func continuationToken(
        signature: String,
        index: Int,
        offset: Int,
        sha256: String?
    ) -> String {
        "read2:\(signature):\(index):\(offset):\(sha256 ?? "")"
    }

    private func displayPath(url: URL, resolver: AllowedPathResolver) -> String {
        for root in resolver.rootURLs where url.path.hasPrefix(root.path + "/") {
            return String(url.path.dropFirst(root.path.count + 1))
        }
        return url.path
    }

    private func rgExecutable() throws -> URL {
        let pathEntries = (ProcessInfo.processInfo.environment["PATH"] ?? "")
            .split(separator: ":").map(String.init)
        let candidates = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"] + pathEntries
        for directory in candidates {
            let url = URL(fileURLWithPath: directory).appendingPathComponent("rg")
            if FileManager.default.isExecutableFile(atPath: url.path) { return url }
        }
        throw AIShellError.workerUnavailable("rg")
    }

    private func runRG(executable: URL, query: String, root: URL) throws -> Data {
        let scratch = FileManager.default.temporaryDirectory
            .appendingPathComponent("AIShellRG-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: scratch, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: scratch) }
        let outputURL = scratch.appendingPathComponent("stdout")
        FileManager.default.createFile(atPath: outputURL.path, contents: nil)
        let output = try FileHandle(forWritingTo: outputURL)
        let process = Process()
        process.executableURL = executable
        process.arguments = [
            "--json", "--line-number", "--color", "never", "--fixed-strings",
            "--glob", "!.git/**", "--glob", "!.build/**", "--glob", "!node_modules/**",
            "--glob", "!.aishell-transactions/**",
            query, root.path
        ]
        process.currentDirectoryURL = root
        process.standardOutput = output
        process.standardError = FileHandle.nullDevice
        try process.run()
        let deadline = Date().addingTimeInterval(30)
        let outputLimit = 64 * 1_024 * 1_024
        var limitFailure: String?
        while process.isRunning {
            if Date() >= deadline {
                limitFailure = "rg exceeded 30 second timeout"
                break
            }
            let size = (try? FileManager.default.attributesOfItem(atPath: outputURL.path)[.size] as? NSNumber)?.intValue ?? 0
            if size > outputLimit {
                limitFailure = "rg output exceeded 64 MiB limit"
                break
            }
            usleep(20_000)
        }
        if let limitFailure {
            process.terminate()
            let graceDeadline = Date().addingTimeInterval(1)
            while process.isRunning, Date() < graceDeadline { usleep(20_000) }
            if process.isRunning { kill(process.processIdentifier, SIGKILL) }
            process.waitUntilExit()
            try output.close()
            throw AIShellError.processLaunchFailed(limitFailure)
        }
        process.waitUntilExit()
        try output.close()
        guard process.terminationStatus == 0 || process.terminationStatus == 1 else {
            throw AIShellError.processLaunchFailed("rg exit \(process.terminationStatus)")
        }
        let finalSize = (try FileManager.default.attributesOfItem(atPath: outputURL.path)[.size] as? NSNumber)?.intValue ?? 0
        guard finalSize <= outputLimit else {
            throw AIShellError.processLaunchFailed("rg output exceeded 64 MiB limit")
        }
        return try Data(contentsOf: outputURL, options: .mappedIfSafe)
    }

    private func parseRG(output: Data, root: URL, changedPaths: Set<String>) -> [SearchContextMatch] {
        String(decoding: output, as: UTF8.self).split(whereSeparator: { $0.isNewline }).compactMap { line in
            guard let object = try? JSONSerialization.jsonObject(with: Data(line.utf8)) as? [String: Any],
                  object["type"] as? String == "match",
                  let data = object["data"] as? [String: Any],
                  let pathObject = data["path"] as? [String: Any],
                  let path = pathObject["text"] as? String,
                  let linesObject = data["lines"] as? [String: Any],
                  let text = linesObject["text"] as? String,
                  let lineNumber = data["line_number"] as? Int else { return nil }
            let absolute = URL(fileURLWithPath: path).standardizedFileURL.path
            let relative = absolute.hasPrefix(root.path + "/")
                ? String(absolute.dropFirst(root.path.count + 1)) : path
            let score = changedPaths.contains(absolute) ? 100 : 10
            return SearchContextMatch(
                path: relative,
                line: lineNumber,
                text: text.trimmingCharacters(in: .newlines),
                score: score
            )
        }
    }

    private static func signature(for targets: [String]) -> String {
        let digest = SHA256.hash(data: Data(targets.joined(separator: "\u{0}").utf8))
        return digest.prefix(8).map { String(format: "%02x", $0) }.joined()
    }

    private func parseSearchContinuation(
        _ continuation: String?,
        signature: String,
        resultDigest: String
    ) throws -> Int {
        guard let continuation else { return 0 }
        let parts = continuation.split(separator: ":", omittingEmptySubsequences: false)
        guard parts.count == 4,
              parts[0] == "search1",
              parts[1] == Substring(signature),
              let index = Int(parts[2]), index >= 0 else {
            throw AIShellError.cursorExpired(continuation)
        }
        guard parts[3] == Substring(resultDigest) else {
            throw AIShellError.contentChanged("search result")
        }
        return index
    }

    private func searchContinuationToken(signature: String, index: Int, resultDigest: String) -> String {
        "search1:\(signature):\(index):\(resultDigest)"
    }

    private static func searchResultDigest(_ matches: [SearchContextMatch]) -> String {
        let value = matches.map { "\($0.path):\($0.line):\($0.text):\($0.score)" }.joined(separator: "\u{0}")
        return SHA256.hash(data: Data(value.utf8)).map { String(format: "%02x", $0) }.joined()
    }

    private static func validUTF8Prefix(data: Data, offset: Int, maximumCount: Int) throws -> Data {
        guard maximumCount > 0 else { return Data() }
        for count in stride(from: maximumCount, through: 1, by: -1) {
            let selected = data.subdata(in: offset..<(offset + count))
            if String(data: selected, encoding: .utf8) != nil { return selected }
        }
        throw AIShellError.invalidArgument("byte_budgetがUTF-8文字境界まで小さすぎます。")
    }
}
