import AIShellCore
import Foundation

final class MCPServer {
    private let store = RuntimeStore()
    private lazy var files = NativeFileService(store: store)
    private lazy var processes = NativeProcessService(store: store)

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
                    "version": .string("0.2.1")
                ]),
                "instructions": .string("SwiftのmacOS APIを直接呼びます。最初にruntime_statusを確認してください。停止中または許可root不足ならruntime_open_managerで管理画面を開けます。process_runはshellを介さず、絶対実行ファイルと引数配列を直接渡します。")
            ]))

        case "ping":
            return .success(id: id, result: .object([:]))

        case "tools/list":
            do {
                return .success(id: id, result: .object([
                    "tools": try .from(ToolCatalog.tools)
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
        let arguments = params["arguments"]?.objectValue ?? [:]

        do {
            let result = try await invoke(name: name, arguments: arguments)
            let text = try resultText(result)
            return .success(id: id, result: .object([
                "content": .array([.object([
                    "type": .string("text"),
                    "text": .string(text)
                ])]),
                "structuredContent": result,
                "isError": .bool(false)
            ]))
        } catch {
            return .success(id: id, result: .object([
                "content": .array([.object([
                    "type": .string("text"),
                    "text": .string(error.localizedDescription)
                ])]),
                "isError": .bool(true)
            ]))
        }
    }

    private func invoke(name: String, arguments: [String: JSONValue]) async throws -> JSONValue {
        switch name {
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

    private func resultText(_ result: JSONValue) throws -> String {
        let data = try JSONEncoder.aishell.encode(result)
        return String(decoding: data, as: UTF8.self)
    }

    private func write(_ response: JSONRPCResponse) throws {
        let data = try JSONEncoder.aishell.encode(response)
        FileHandle.standardOutput.write(data)
        FileHandle.standardOutput.write(Data([0x0A]))
    }
}
