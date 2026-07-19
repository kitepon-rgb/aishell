import AIShellCore
import Foundation

final class MCPServer {
    private let store = RuntimeStore()
    private let toolProfile = ProcessInfo.processInfo.environment["AISHELL_TOOL_PROFILE"]
        ?? "development"
    private lazy var files = NativeFileService(store: store)
    private lazy var processes = NativeProcessService(store: store)
    private lazy var development = DevelopmentRuntimeService(runtimeStore: store)

    func run() async {
        while let line = readLine() {
            guard let data = line.data(using: .utf8) else { continue }

            do {
                let request = try JSONDecoder.aishell.decode(JSONRPCRequest.self, from: data)
                if let response = await handle(request) {
                    try write(response)
                }
            } catch {
                let response = JSONRPCResponse.failure(
                    id: .null,
                    code: -32700,
                    message: "JSON-RPCを解析できません: \(error.localizedDescription)"
                )
                try? write(response)
            }
        }
    }

    private func handle(_ request: JSONRPCRequest) async -> JSONRPCResponse? {
        guard request.jsonrpc == "2.0" else {
            return request.id.map {
                .failure(id: $0, code: -32600, message: "jsonrpcは2.0である必要があります。")
            }
        }

        guard let id = request.id else {
            return nil
        }

        switch request.method {
        case "initialize":
            return .success(id: id, result: .object([
                "protocolVersion": .string("2025-11-25"),
                "capabilities": .object([
                    "tools": .object(["listChanged": .bool(false)])
                ]),
                "serverInfo": .object([
                    "name": .string("aishell-macos"),
                    "version": .string("0.3.3")
                ]),
                "instructions": .string("macOSの生きたfilesystem・process・artifact状態を直接所有します。tinyなsingle-file taskはhost native toolを使います。反復またはmulti-file観測だけworkspace_snapshotから開始し埋込contextを先に使います。32KiB超の出力が見込まれる検査だけrun_checkを使い、artifact_readは主要診断が不足する時だけ使います。search_context/read_contextはsnapshot不足時のdrilldownです。")
            ]))

        case "ping":
            return .success(id: id, result: .object([:]))

        case "tools/list":
            do {
                return .success(id: id, result: .object([
                    "tools": try .from(ToolCatalog.listedTools(profile: toolProfile))
                ]))
            } catch {
                return .failure(id: id, code: -32603, message: error.localizedDescription)
            }

        case "tools/call":
            return await callTool(id: id, params: request.params)

        default:
            return .failure(id: id, code: -32601, message: "未対応のmethodです: \(request.method)")
        }
    }

    private func callTool(id: JSONValue, params: JSONValue?) async -> JSONRPCResponse {
        guard let params = params?.objectValue,
              let name = params["name"]?.stringValue else {
            return .failure(id: id, code: -32602, message: "tools/callにはnameが必要です。")
        }
        guard ToolCatalog.listedTools(profile: toolProfile).contains(where: { $0.name == name }) else {
            return .failure(id: id, code: -32602, message: "未定義のtoolです: \(name)")
        }
        let arguments: [String: JSONValue]
        if let value = params["arguments"] {
            guard let object = value.objectValue else {
                return .failure(id: id, code: -32602, message: "tools/callのargumentsはobjectである必要があります。")
            }
            arguments = object
        } else {
            arguments = [:]
        }

        do {
            let result = try await invoke(name: name, arguments: arguments)
            let text = try resultText(name: name, result: result)
            let structured = structuredProjection(name: name, result: result)
            return .success(id: id, result: .object([
                "content": .array([.object([
                    "type": .string("text"),
                    "text": .string(text)
                ])]),
                "structuredContent": structured,
                "isError": .bool(false)
            ]))
        } catch {
            let stableError = stableError(error)
            return .success(id: id, result: .object([
                "content": .array([.object([
                    "type": .string("text"),
                    "text": .string("\(stableError.code): \(stableError.message)")
                ])]),
                "structuredContent": .object([
                    "schemaVersion": .string("aishell.error.v1"),
                    "error": .object([
                        "code": .string(stableError.code),
                        "message": .string(stableError.message)
                    ])
                ]),
                "isError": .bool(true)
            ]))
        }
    }

    private func invoke(name: String, arguments: [String: JSONValue]) async throws -> JSONValue {
        switch name {
        case "run_check":
            try validateKeys(arguments, allowed: [
                "executable", "arguments", "working_directory", "environment",
                "timeout_seconds", "retention_seconds"
            ])
            return try await .from(development.runCheck(
                executable: requiredString("executable", in: arguments),
                arguments: try stringArray("arguments", in: arguments),
                workingDirectory: try strictOptionalString("working_directory", in: arguments),
                environment: try stringMap("environment", in: arguments),
                timeoutSeconds: try boundedDouble(
                    "timeout_seconds", in: arguments, default: 120, minimum: 0.1, maximum: 3_600
                ),
                retentionSeconds: try boundedDouble(
                    "retention_seconds", in: arguments,
                    default: EvidenceStore.defaultRetentionSeconds, minimum: 1, maximum: 604_800
                )
            ))
        case "artifact_read":
            try validateKeys(arguments, allowed: [
                "handle", "mode", "offset", "length", "tail_lines", "pattern",
                "context_lines", "byte_budget"
            ])
            let modeName = try strictOptionalString("mode", in: arguments) ?? "range"
            let mode: ArtifactReadMode
            switch modeName {
            case "range":
                mode = .range(
                    offset: try boundedInt("offset", in: arguments, default: 0, minimum: 0, maximum: Int.max),
                    length: try boundedInt("length", in: arguments, default: 65_536, minimum: 0, maximum: 1_048_576)
                )
            case "tail":
                mode = .tail(lines: try boundedInt("tail_lines", in: arguments, default: 100, minimum: 1, maximum: 1_000_000))
            case "around":
                mode = .around(
                    pattern: try requiredString("pattern", in: arguments),
                    contextLines: try boundedInt("context_lines", in: arguments, default: 2, minimum: 0, maximum: 10_000)
                )
            default:
                throw AIShellError.invalidArgument("modeはrange、tail、aroundのいずれかです。")
            }
            return try await .from(development.readArtifact(
                handle: requiredString("handle", in: arguments),
                mode: mode,
                byteBudget: try boundedInt("byte_budget", in: arguments, default: 65_536, minimum: 1, maximum: 1_048_576)
            ))
        case "workspace_snapshot":
            try validateKeys(arguments, allowed: ["path", "since_cursor", "entry_limit", "context_budget"])
            return try await .from(development.workspaceSnapshot(
                path: try strictOptionalString("path", in: arguments),
                sinceCursor: try strictOptionalString("since_cursor", in: arguments),
                entryLimit: try boundedInt("entry_limit", in: arguments, default: 500, minimum: 1, maximum: 5_000),
                contextBudget: try boundedInt("context_budget", in: arguments, default: 16_384, minimum: 0, maximum: 65_536)
            ))
        case "read_context":
            try validateKeys(arguments, allowed: ["targets", "byte_budget", "continuation"])
            return try await .from(development.readContext(
                targets: try stringArray("targets", in: arguments),
                byteBudget: try boundedInt("byte_budget", in: arguments, default: 65_536, minimum: 1, maximum: 1_048_576),
                continuation: try strictOptionalString("continuation", in: arguments)
            ))
        case "search_context":
            try validateKeys(arguments, allowed: ["query", "path", "max_results", "byte_budget", "continuation"])
            return try await .from(development.searchContext(
                query: try requiredString("query", in: arguments),
                path: try strictOptionalString("path", in: arguments),
                maxResults: try boundedInt("max_results", in: arguments, default: 50, minimum: 1, maximum: 500),
                byteBudget: try boundedInt("byte_budget", in: arguments, default: 65_536, minimum: 1, maximum: 1_048_576),
                continuation: try strictOptionalString("continuation", in: arguments)
            ))
        case "runtime_status":
            return try await runtimeStatus()
        case "runtime_open_manager":
            return try await .from(NativeApplicationService(store: store).openManagerApplication(
                at: try managerApplicationURL()
            ))
        case "files_list":
            return try await .from(files.list(path: optionalString("path", in: arguments)))
        case "files_search":
            return try await .from(files.search(
                query: try requiredString("query", in: arguments),
                path: optionalString("path", in: arguments),
                limit: arguments["limit"]?.intValue ?? 100
            ))
        case "files_read_text":
            return .object([
                "text": .string(try await files.readText(path: requiredString("path", in: arguments)))
            ])
        case "files_stat":
            return try await .from(files.stat(
                path: requiredString("path", in: arguments),
                includeHash: arguments["include_hash"]?.boolValue ?? true
            ))
        case "files_tree":
            return try await .from(files.tree(
                path: optionalString("path", in: arguments),
                maxDepth: arguments["max_depth"]?.intValue ?? 4,
                limit: arguments["limit"]?.intValue ?? 500
            ))
        case "files_create_directory":
            return try await .from(files.createDirectory(path: requiredString("path", in: arguments)))
        case "files_create_text":
            return try await .from(files.createTextFile(
                path: requiredString("path", in: arguments),
                content: requiredString("content", in: arguments)
            ))
        case "files_write_text":
            return try await .from(files.writeText(
                path: requiredString("path", in: arguments),
                content: requiredStringAllowingEmpty("content", in: arguments),
                expectedSHA256: optionalString("expected_sha256", in: arguments)
            ))
        case "files_replace_text":
            return try await .from(files.replaceText(
                path: requiredString("path", in: arguments),
                oldText: requiredString("old_text", in: arguments),
                newText: requiredStringAllowingEmpty("new_text", in: arguments),
                replaceAll: arguments["replace_all"]?.boolValue ?? false
            ))
        case "files_copy":
            return try await .from(files.copy(
                source: requiredString("source", in: arguments),
                destination: requiredString("destination", in: arguments)
            ))
        case "files_move":
            return try await .from(files.move(
                source: requiredString("source", in: arguments),
                destination: requiredString("destination", in: arguments)
            ))
        case "files_rename":
            return try await .from(files.rename(
                path: requiredString("path", in: arguments),
                newName: requiredString("new_name", in: arguments)
            ))
        case "files_trash":
            return .object([
                "trashed_path": .string(try await files.trash(path: requiredString("path", in: arguments)))
            ])
        case "apps_list_running":
            return try await .from(NativeApplicationService(store: store).listRunningApplications())
        case "apps_list_installed":
            return try await .from(NativeApplicationService(store: store).listInstalledApplications())
        case "apps_open":
            return try await .from(NativeApplicationService(store: store).openApplication(
                bundleIdentifier: requiredString("bundle_identifier", in: arguments)
            ))
        case "apps_activate":
            return try await .from(NativeApplicationService(store: store).activateApplication(
                bundleIdentifier: requiredString("bundle_identifier", in: arguments)
            ))
        case "process_run":
            return try await .from(processes.run(
                executable: requiredString("executable", in: arguments),
                arguments: try stringArray("arguments", in: arguments),
                workingDirectory: optionalString("working_directory", in: arguments),
                environment: try stringMap("environment", in: arguments),
                timeoutSeconds: arguments["timeout_seconds"]?.doubleValue ?? 120
            ))
        default:
            throw AIShellError.invalidArgument("未定義のtoolです: \(name)")
        }
    }

    private func runtimeStatus() async throws -> JSONValue {
        let configuration = try await store.loadConfiguration()
        let resolver = try? AllowedPathResolver(rootPaths: configuration.allowedRootPaths)
        let automaticWorktrees = resolver?.gitWorktreeRootURLs.map(\.path) ?? []
        let effectiveRoots = resolver?.rootURLs.map(\.path) ?? configuration.allowedRootPaths
        let primary = configuration.primaryAllowedRootPath.map(JSONValue.string) ?? .null
        let nextAction: String
        if configuration.isPaused {
            nextAction = "runtime_open_managerを呼び、AIShell画面で再開してください。"
        } else if configuration.allowedRootPaths.isEmpty {
            nextAction = "runtime_open_managerを呼び、AIShell画面で許可rootを追加してください。"
        } else {
            nextAction = "利用可能です。絶対パスはeffectiveAllowedRootPaths、相対パスはprimaryAllowedRootPathを基準にします。Git worktreeは自動認識されるため手動追加しないでください。"
        }

        return .object([
            "allowedRootPaths": .array(configuration.allowedRootPaths.map(JSONValue.string)),
            "automaticGitWorktreePaths": .array(automaticWorktrees.map(JSONValue.string)),
            "effectiveAllowedRootPaths": .array(effectiveRoots.map(JSONValue.string)),
            "primaryAllowedRootPath": primary,
            "relativePathBase": primary,
            "isPaused": .bool(configuration.isPaused),
            "updatedAt": .string(ISO8601DateFormatter().string(from: configuration.updatedAt)),
            "managerTool": .string("runtime_open_manager"),
            "nextAction": .string(nextAction)
        ])
    }

    private func managerApplicationURL() throws -> URL {
        let executableURL = URL(fileURLWithPath: CommandLine.arguments[0])
            .resolvingSymlinksInPath()
            .standardizedFileURL
        let applicationURL = executableURL
            .deletingLastPathComponent() // Helpers
            .deletingLastPathComponent() // Contents
            .deletingLastPathComponent() // AIShell.app
        guard applicationURL.pathExtension == "app" else {
            throw AIShellError.invalidPath(
                "実行中のMCP helperに対応するAIShell.appを特定できません。@quolu/aishellを再インストールしてください。"
            )
        }
        return applicationURL
    }

    private func requiredString(_ key: String, in arguments: [String: JSONValue]) throws -> String {
        guard let value = arguments[key]?.stringValue, !value.isEmpty else {
            throw AIShellError.invalidArgument("\(key)には空でない文字列が必要です。")
        }
        return value
    }

    private func requiredStringAllowingEmpty(
        _ key: String,
        in arguments: [String: JSONValue]
    ) throws -> String {
        guard let value = arguments[key]?.stringValue else {
            throw AIShellError.invalidArgument("\(key)には文字列が必要です。")
        }
        return value
    }

    private func optionalString(_ key: String, in arguments: [String: JSONValue]) -> String? {
        arguments[key]?.stringValue
    }

    private func strictOptionalString(_ key: String, in arguments: [String: JSONValue]) throws -> String? {
        guard let value = arguments[key] else { return nil }
        guard let string = value.stringValue else {
            throw AIShellError.invalidArgument("\(key)には文字列が必要です。")
        }
        return string
    }

    private func boundedInt(
        _ key: String,
        in arguments: [String: JSONValue],
        default defaultValue: Int,
        minimum: Int,
        maximum: Int
    ) throws -> Int {
        guard let value = arguments[key] else { return defaultValue }
        guard let integer = value.intValue, (minimum...maximum).contains(integer) else {
            throw AIShellError.invalidArgument("\(key)は\(minimum)〜\(maximum)の整数である必要があります。")
        }
        return integer
    }

    private func boundedDouble(
        _ key: String,
        in arguments: [String: JSONValue],
        default defaultValue: Double,
        minimum: Double,
        maximum: Double
    ) throws -> Double {
        guard let value = arguments[key] else { return defaultValue }
        guard let number = value.doubleValue, number.isFinite, (minimum...maximum).contains(number) else {
            throw AIShellError.invalidArgument("\(key)は\(minimum)〜\(maximum)の数値である必要があります。")
        }
        return number
    }

    private func stringArray(_ key: String, in arguments: [String: JSONValue]) throws -> [String] {
        guard let value = arguments[key] else { return [] }
        guard let array = value.arrayValue else {
            throw AIShellError.invalidArgument("\(key)には文字列配列が必要です。")
        }
        return try array.map { item in
            guard let string = item.stringValue else {
                throw AIShellError.invalidArgument("\(key)には文字列配列が必要です。")
            }
            return string
        }
    }

    private func stringMap(_ key: String, in arguments: [String: JSONValue]) throws -> [String: String] {
        guard let value = arguments[key] else { return [:] }
        guard let object = value.objectValue else {
            throw AIShellError.invalidArgument("\(key)には文字列値のobjectが必要です。")
        }
        return try object.mapValues { item in
            guard let string = item.stringValue else {
                throw AIShellError.invalidArgument("\(key)の値は文字列である必要があります。")
            }
            return string
        }
    }

    private func validateKeys(_ arguments: [String: JSONValue], allowed: Set<String>) throws {
        let unexpected = Set(arguments.keys).subtracting(allowed).sorted()
        guard unexpected.isEmpty else {
            throw AIShellError.invalidArgument("未定義の引数です: \(unexpected.joined(separator: ", "))")
        }
    }

    private func stableError(_ error: Error) -> (code: String, message: String) {
        guard let error = error as? AIShellError else {
            return ("INTERNAL_ERROR", error.localizedDescription)
        }
        switch error {
        case .notConfigured: return ("NOT_CONFIGURED", error.localizedDescription)
        case .paused: return ("RUNTIME_PAUSED", error.localizedDescription)
        case .outsideAllowedRoot: return ("OUTSIDE_ALLOWED_ROOT", error.localizedDescription)
        case .invalidPath: return ("INVALID_PATH", error.localizedDescription)
        case .itemAlreadyExists: return ("ITEM_ALREADY_EXISTS", error.localizedDescription)
        case .itemNotFound: return ("ITEM_NOT_FOUND", error.localizedDescription)
        case .notTextFile: return ("NOT_TEXT_FILE", error.localizedDescription)
        case .textFileTooLarge: return ("TEXT_TOO_LARGE", error.localizedDescription)
        case .applicationNotFound: return ("APPLICATION_NOT_FOUND", error.localizedDescription)
        case .applicationActivationFailed: return ("APPLICATION_ACTIVATION_FAILED", error.localizedDescription)
        case .contentChanged: return ("CONTENT_CHANGED", error.localizedDescription)
        case .executableNotAllowed: return ("EXECUTABLE_NOT_ALLOWED", error.localizedDescription)
        case .processLaunchFailed: return ("PROCESS_LAUNCH_FAILED", error.localizedDescription)
        case .handleNotFound: return ("ARTIFACT_NOT_FOUND", error.localizedDescription)
        case .handleExpired: return ("HANDLE_EXPIRED", error.localizedDescription)
        case .evidenceQuotaExceeded: return ("EVIDENCE_QUOTA_EXCEEDED", error.localizedDescription)
        case .cursorExpired: return ("CURSOR_EXPIRED", error.localizedDescription)
        case .rescanRequired: return ("RESCAN_REQUIRED", error.localizedDescription)
        case .workerUnavailable: return ("WORKER_UNAVAILABLE", error.localizedDescription)
        case .invalidArgument: return ("INVALID_ARGUMENT", error.localizedDescription)
        }
    }

    private func resultText(name: String, result: JSONValue) throws -> String {
        if name == "run_check", let summary = result.objectValue?["summary"]?.stringValue {
            return summary
        }
        if name == "artifact_read", let object = result.objectValue {
            if let text = object["text"]?.stringValue { return text }
            if let base64 = object["base64"]?.stringValue { return "base64:\(base64)" }
        }
        if name == "workspace_snapshot", let object = result.objectValue {
            let mode = object["isFull"]?.boolValue == true ? "full" : "delta"
            let entries = object["entries"]?.arrayValue?.count ?? 0
            let changes = object["changes"]?.arrayValue?.count ?? 0
            let omitted = object["omittedEntries"]?.intValue ?? 0
            let cursor = object["cursor"]?.stringValue ?? ""
            let header = "snapshot \(mode): entries=\(entries) changes=\(changes) omitted=\(omitted) cursor=\(cursor)"
            let context = object["context"]?.arrayValue?.compactMap { value -> String? in
                guard let chunk = value.objectValue,
                      let path = chunk["path"]?.stringValue,
                      let text = chunk["text"]?.stringValue else { return nil }
                return "// --- \(path) ---\n\(text)"
            }.joined(separator: "\n") ?? ""
            return context.isEmpty ? header : "\(header)\n\(context)"
        }
        if name == "read_context", let chunks = result.objectValue?["chunks"]?.arrayValue {
            return chunks.compactMap { value in
                guard let object = value.objectValue,
                      let path = object["path"]?.stringValue,
                      let text = object["text"]?.stringValue else { return nil }
                return "// --- \(path) ---\n\(text)"
            }.joined(separator: "\n")
        }
        if name == "search_context", let matches = result.objectValue?["matches"]?.arrayValue {
            return matches.compactMap { value in
                guard let object = value.objectValue,
                      let path = object["path"]?.stringValue,
                      let line = object["line"]?.intValue,
                      let text = object["text"]?.stringValue else { return nil }
                return "\(path):\(line): \(text)"
            }.joined(separator: "\n")
        }
        let data = try JSONEncoder.aishell.encode(result)
        return String(decoding: data, as: UTF8.self)
    }

    func structuredProjection(name: String, result: JSONValue) -> JSONValue {
        guard var object = result.objectValue else { return result }
        if name == "artifact_read" {
            object.removeValue(forKey: "text")
            object.removeValue(forKey: "base64")
        } else if name == "workspace_snapshot", let context = object["context"]?.arrayValue {
            object["context"] = .array(context.map { value in
                guard var chunk = value.objectValue else { return value }
                chunk.removeValue(forKey: "text")
                return .object(chunk)
            })
        } else if name == "read_context", let chunks = object["chunks"]?.arrayValue {
            object["chunks"] = .array(chunks.map { value in
                guard var chunk = value.objectValue else { return value }
                chunk.removeValue(forKey: "text")
                return .object(chunk)
            })
        } else if name == "search_context", let matches = object["matches"]?.arrayValue {
            object["matches"] = .array(matches.map { value in
                guard var match = value.objectValue else { return value }
                match.removeValue(forKey: "text")
                return .object(match)
            })
        }
        return .object(object)
    }

    private func write(_ response: JSONRPCResponse) throws {
        let data = try JSONEncoder.aishell.encode(response)
        FileHandle.standardOutput.write(data)
        FileHandle.standardOutput.write(Data([0x0A]))
    }
}
