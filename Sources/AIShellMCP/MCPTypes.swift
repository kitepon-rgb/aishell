import Foundation

struct JSONRPCRequest: Decodable, Sendable {
    let jsonrpc: String
    let id: JSONValue?
    let method: String
    let params: JSONValue?
}

struct JSONRPCResponse: Encodable, Sendable {
    let jsonrpc = "2.0"
    let id: JSONValue
    let result: JSONValue?
    let error: JSONRPCError?

    static func success(id: JSONValue, result: JSONValue) -> JSONRPCResponse {
        JSONRPCResponse(id: id, result: result, error: nil)
    }

    static func failure(id: JSONValue, code: Int, message: String) -> JSONRPCResponse {
        JSONRPCResponse(
            id: id,
            result: nil,
            error: JSONRPCError(code: code, message: message)
        )
    }
}

struct JSONRPCError: Encodable, Sendable {
    let code: Int
    let message: String
}

struct MCPTool: Encodable, Sendable {
    let name: String
    let title: String
    let description: String
    let inputSchema: JSONValue
    let outputSchema: JSONValue?
    let annotations: MCPToolAnnotations
}

struct MCPToolAnnotations: Encodable, Sendable {
    let readOnlyHint: Bool
    let destructiveHint: Bool
    let idempotentHint: Bool
    let openWorldHint: Bool
}

enum ToolCatalog {
    static let developmentToolNames: Set<String> = [
        "run_check", "artifact_read", "workspace_snapshot", "read_context", "search_context"
    ]
    static let controlToolNames: Set<String> = [
        "runtime_status", "runtime_open_manager"
    ]
    static let defaultToolNames = developmentToolNames.union(controlToolNames)

    static func listedTools(profile: String?) -> [MCPTool] {
        switch profile {
        case "full", "legacy":
            tools
        default:
            tools.filter { defaultToolNames.contains($0.name) }.map(compactTool)
        }
    }

    private static func compactTool(_ tool: MCPTool) -> MCPTool {
        let descriptions = [
            "run_check": "直接実行し、短い成否・診断と完全log handleを返す。",
            "artifact_read": "artifactをrange、tail、pattern周辺でbudget読取する。",
            "workspace_snapshot": "初回状態のbounded previewと埋込context、以後のFSEvents deltaを返す。",
            "read_context": "複数fileを共有byte budgetとcontinuationで読む。",
            "search_context": "rg workerで変更近接性付きbounded検索を行う。"
        ]
        return MCPTool(
            name: tool.name,
            title: tool.title,
            description: descriptions[tool.name] ?? tool.description,
            inputSchema: removingDescriptions(tool.inputSchema),
            outputSchema: tool.outputSchema,
            annotations: tool.annotations
        )
    }

    private static func removingDescriptions(_ value: JSONValue) -> JSONValue {
        switch value {
        case let .object(object):
            return .object(object.filter { $0.key != "description" }.mapValues(removingDescriptions))
        case let .array(array):
            return .array(array.map(removingDescriptions))
        default:
            return value
        }
    }

    static let tools: [MCPTool] = [
        tool(
            "run_check", "検査を直接実行", "compilerやtest runnerをshellなしで直接起動し、短い成否・主要診断・完全stdout/stderrのartifact handleを返します。通常responseへ巨大logを展開しません。",
            properties: [
                "executable": string("実行ファイル名または絶対パス。PATHはAIShellが解決し、shellとenvは拒否します"),
                "arguments": stringArray("引数配列。shell展開は行いません"),
                "working_directory": string("許可root内の作業ディレクトリ。省略時は先頭root"),
                "environment": stringMap("追加・上書きする環境変数"),
                "timeout_seconds": number("timeout秒。0.1〜3600、既定120", minimum: 0.1, maximum: 3600),
                "retention_seconds": number("完全logを保持する秒数。最小1、既定86400", minimum: 1)
            ],
            required: ["executable"], destructive: true, idempotent: false, openWorld: true,
            outputSchema: objectOutput(
                schemaVersion: "aishell.run-check.v1",
                required: ["schemaVersion", "requestID", "status", "summary", "exitCode", "stdoutArtifact", "stderrArtifact"],
                properties: [
                    "requestID": type("string"), "status": enumType(["passed", "failed", "timed_out"]),
                    "summary": type("string"), "exitCode": nullableType("integer"),
                    "stdoutArtifact": type("object"), "stderrArtifact": type("object")
                ]
            )
        ),
        tool(
            "artifact_read", "完全証拠を部分読取", "run_check等が保持したartifactをrange、tail、pattern周辺のいずれかでbudget内にlossless取得します。期限切れはHANDLE_EXPIREDで停止します。",
            properties: [
                "handle": string("art_で始まるartifact handle"),
                "mode": enumString(["range", "tail", "around"], "読取mode。既定range"),
                "offset": integer("range開始byte offset。既定0", minimum: 0),
                "length": integer("range長。既定65536", minimum: 0),
                "tail_lines": integer("tailの行数。既定100", minimum: 1),
                "pattern": string("aroundで探す文字列"),
                "context_lines": integer("aroundの前後行数。既定2", minimum: 0),
                "byte_budget": integer("返却上限byte。1〜1048576、既定65536", minimum: 1, maximum: 1_048_576)
            ],
            required: ["handle"], readOnly: true, idempotent: true,
            outputSchema: objectOutput(
                required: ["handle", "encoding", "offset", "returnedBytes", "totalBytes", "omittedBytes", "eof", "sha256", "expiresAt"],
                properties: [
                    "handle": type("string"), "encoding": enumType(["utf-8", "base64"]),
                    "offset": type("integer"), "returnedBytes": type("integer"),
                    "totalBytes": type("integer"), "omittedBytes": type("integer"),
                    "eof": type("boolean"), "sha256": type("string"), "expiresAt": type("string")
                ]
            )
        ),
        tool(
            "workspace_snapshot", "workspace現在状態のpreviewと差分", "初回は現在filesystemを確定してbounded previewを返し、以後はFSEventsで観測したpathだけをidentity/hash照合します。omittedEntriesはpreview外の件数です。event gapや期限切れcursorは黙ってfull scanせず明示errorにします。",
            properties: [
                "path": string("snapshot root。省略時は先頭許可root"),
                "since_cursor": string("前回cursor。省略時は明示的なfull snapshot"),
                "entry_limit": integer("最大entry/change件数。1〜5000、既定500", minimum: 1, maximum: 5_000),
                "context_budget": integer("guidance・manifest・test・小規模workspace本文、またはdelta本文の共有byte上限。0〜65536、既定16384", minimum: 0, maximum: 65_536)
            ],
            required: [], readOnly: true, idempotent: true,
            outputSchema: objectOutput(
                schemaVersion: "aishell.workspace-snapshot.v1",
                required: ["schemaVersion", "root", "cursor", "isFull", "freshness", "entries", "changes", "omittedEntries", "guidanceFiles", "gitStatusState", "gitStatus", "context"],
                properties: [
                    "root": type("string"), "cursor": type("string"), "isFull": type("boolean"),
                    "freshness": enumType(["fresh"]), "entries": type("array"), "changes": type("array"),
                    "omittedEntries": type("integer"), "guidanceFiles": type("array"),
                    "gitStatusState": enumType(["clean", "dirty", "not_repository"]),
                    "gitStatus": type("array"), "context": type("array")
                ]
            )
        ),
        tool(
            "read_context", "複数fileを共有budgetで読取", "複数targetを一つのbyte budgetで読み、SHA、omitted bytes、明示continuationを返します。巨大fileや後続fileを暗黙切捨てしません。",
            properties: [
                "targets": stringArray("許可root内の相対または絶対file path配列"),
                "byte_budget": integer("全target共有の返却上限byte。1〜1048576、既定65536", minimum: 1, maximum: 1_048_576),
                "continuation": string("前回結果のcontinuation")
            ],
            required: ["targets"], readOnly: true, idempotent: true,
            outputSchema: objectOutput(
                schemaVersion: "aishell.read-context.v1",
                required: ["schemaVersion", "chunks", "returnedBytes", "omittedBytes"],
                properties: ["chunks": type("array"), "returnedBytes": type("integer"), "omittedBytes": type("integer")]
            )
        ),
        tool(
            "search_context", "変更近接性付きlexical検索", "rgをshellなしで直接起動し、OS観測済み変更へ近いmatchを優先して件数・byte budget内に返します。",
            properties: [
                "query": string("固定文字列query"),
                "path": string("検索root。省略時は先頭許可root"),
                "max_results": integer("最大match数。1〜500、既定50", minimum: 1, maximum: 500),
                "byte_budget": integer("返却上限byte。1〜1048576、既定65536", minimum: 1, maximum: 1_048_576),
                "continuation": string("前回結果のcontinuation。検索結果変更時はCONTENT_CHANGED")
            ],
            required: ["query"], readOnly: true, idempotent: true,
            outputSchema: objectOutput(
                schemaVersion: "aishell.search-context.v1",
                required: ["schemaVersion", "query", "worker", "matches", "omittedMatches", "returnedBytes", "omittedBytes", "freshness"],
                properties: [
                    "query": type("string"), "worker": type("string"), "matches": type("array"),
                    "omittedMatches": type("integer"), "returnedBytes": type("integer"),
                    "omittedBytes": type("integer"), "freshness": enumType(["filesystem-current"])
                ]
            )
        ),
        tool(
            "runtime_status", "実行状態", "設定root、自動認識したGit worktree、実効root、停止状態、相対パスの基準、次に必要な操作を取得します。Git worktreeを手動追加する必要はありません。停止中でも利用できます。",
            properties: [:], required: [], readOnly: true, idempotent: true,
            outputSchema: objectOutput(
                required: ["allowedRootPaths", "automaticGitWorktreePaths", "effectiveAllowedRootPaths", "primaryAllowedRootPath", "relativePathBase", "isPaused", "updatedAt", "managerTool", "nextAction"],
                properties: [
                    "allowedRootPaths": type("array"), "automaticGitWorktreePaths": type("array"),
                    "effectiveAllowedRootPaths": type("array"), "primaryAllowedRootPath": nullableType("string"),
                    "relativePathBase": nullableType("string"), "isPaused": type("boolean"),
                    "updatedAt": type("string"), "managerTool": type("string"), "nextAction": type("string")
                ]
            )
        ),
        tool(
            "runtime_open_manager", "管理画面を開く", "AIShellが停止中でも管理画面を開きます。許可rootの追加・削除と再開は画面上で行います。",
            properties: [:], required: [], idempotent: true,
            outputSchema: objectOutput(
                required: ["name", "processIdentifier", "isActive"],
                properties: [
                    "name": type("string"), "bundleIdentifier": nullableType("string"),
                    "processIdentifier": type("integer"), "isActive": type("boolean")
                ]
            )
        ),
        tool(
            "files_list", "フォルダ一覧", "許可root内の項目を一覧します。pathを省略すると先頭の許可rootです。",
            properties: ["path": string("先頭rootからの相対パス、またはいずれかの許可root内の絶対パス")],
            required: [], readOnly: true, idempotent: true
        ),
        tool(
            "files_search", "ファイル検索", "許可フォルダ内をファイル名で再帰検索します。",
            properties: [
                "query": string("検索文字列"),
                "path": string("検索開始パス。省略時は許可ルート"),
                "limit": integer("最大件数。1〜500")
            ],
            required: ["query"], readOnly: true, idempotent: true
        ),
        tool(
            "files_read_text", "テキスト読取", "1MB以下のUTF-8テキストを読み取ります。",
            properties: ["path": string("対象ファイルのパス")],
            required: ["path"], readOnly: true, idempotent: true
        ),
        tool(
            "files_stat", "ファイル情報", "ファイル情報、POSIX permission、必要ならSHA-256を取得します。",
            properties: [
                "path": string("対象パス"),
                "include_hash": boolean("ファイルのSHA-256を計算する。既定true")
            ],
            required: ["path"], readOnly: true, idempotent: true
        ),
        tool(
            "files_tree", "ディレクトリツリー", "許可フォルダ内を深さと件数を制限して再帰一覧します。",
            properties: [
                "path": string("開始パス。省略時は許可ルート"),
                "max_depth": integer("最大深さ。1〜20"),
                "limit": integer("最大件数。1〜2000")
            ],
            required: [], readOnly: true, idempotent: true
        ),
        tool(
            "files_create_directory", "フォルダ作成", "許可フォルダ内へ新しいフォルダを作成します。",
            properties: ["path": string("作成するフォルダのパス")],
            required: ["path"], idempotent: false
        ),
        tool(
            "files_create_text", "テキスト作成", "既存項目を上書きせず、新しいUTF-8テキストファイルを作成します。",
            properties: [
                "path": string("作成するファイルのパス"),
                "content": string("書き込む内容")
            ],
            required: ["path", "content"], idempotent: false
        ),
        tool(
            "files_write_text", "テキスト更新", "新規作成または既存テキストを原子的に更新します。既存ファイルにはfiles_statで得たexpected_sha256が必要です。",
            properties: [
                "path": string("対象ファイルのパス"),
                "content": string("更新後の全内容"),
                "expected_sha256": string("既存ファイルを読み取った時点のSHA-256")
            ],
            required: ["path", "content"], idempotent: false
        ),
        tool(
            "files_replace_text", "部分置換", "old_textを事前条件としてUTF-8テキストの一部を置換します。",
            properties: [
                "path": string("対象ファイルのパス"),
                "old_text": string("置換対象の正確な文字列"),
                "new_text": string("置換後の文字列"),
                "replace_all": boolean("一致箇所をすべて置換する。既定false")
            ],
            required: ["path", "old_text", "new_text"], idempotent: false
        ),
        tool(
            "files_copy", "ファイルコピー", "許可フォルダ内で項目をコピーします。既存項目は上書きしません。",
            properties: [
                "source": string("コピー元パス"),
                "destination": string("コピー先パス")
            ],
            required: ["source", "destination"], idempotent: false
        ),
        tool(
            "files_move", "ファイル移動", "許可フォルダ内で項目を移動します。既存項目は上書きしません。",
            properties: [
                "source": string("移動元パス"),
                "destination": string("移動先パス")
            ],
            required: ["source", "destination"], idempotent: false
        ),
        tool(
            "files_rename", "名前変更", "許可フォルダ内の項目名を変更します。",
            properties: [
                "path": string("対象パス"),
                "new_name": string("新しいファイル名。パスは含めません")
            ],
            required: ["path", "new_name"], idempotent: false
        ),
        tool(
            "files_trash", "Trashへ移動", "項目を完全削除せずmacOSのTrashへ移動します。",
            properties: ["path": string("対象パス")],
            required: ["path"], destructive: true, idempotent: false
        ),
        tool(
            "apps_list_running", "実行中アプリ", "実行中の通常アプリを一覧します。",
            properties: [:], required: [], readOnly: true, idempotent: true
        ),
        tool(
            "apps_list_installed", "インストール済みアプリ", "標準Applicationsフォルダにあるアプリを一覧します。",
            properties: [:], required: [], readOnly: true, idempotent: true
        ),
        tool(
            "apps_open", "アプリ起動", "bundle identifierを指定してアプリを起動します。",
            properties: ["bundle_identifier": string("例: com.apple.TextEdit")],
            required: ["bundle_identifier"], idempotent: true
        ),
        tool(
            "apps_activate", "アプリ前面化", "実行中アプリを前面化します。",
            properties: ["bundle_identifier": string("例: com.apple.TextEdit")],
            required: ["bundle_identifier"], idempotent: true
        ),
        tool(
            "process_run", "プログラム直接実行", "shellを介さず、PATH解決した実行ファイルへ引数配列を直接渡します。stdout、stderr、終了コードを返します。",
            properties: [
                "executable": string("実行ファイル名または絶対パス。PATHはAIShellが解決し、shellとenvは拒否します"),
                "arguments": stringArray("引数配列。shell展開は行いません"),
                "working_directory": string("いずれかの許可root内の作業ディレクトリ。省略時は先頭root"),
                "environment": stringMap("追加・上書きする環境変数"),
                "timeout_seconds": number("timeout秒。0.1〜3600、既定120")
            ],
            required: ["executable"], destructive: true, idempotent: false, openWorld: true
        )
    ]

    private static func tool(
        _ name: String,
        _ title: String,
        _ description: String,
        properties: [String: JSONValue],
        required: [String],
        readOnly: Bool = false,
        destructive: Bool = false,
        idempotent: Bool,
        openWorld: Bool = false,
        outputSchema: JSONValue? = nil
    ) -> MCPTool {
        MCPTool(
            name: name,
            title: title,
            description: description,
            inputSchema: .object([
                "type": .string("object"),
                "properties": .object(properties),
                "required": .array(required.map(JSONValue.string)),
                "additionalProperties": .bool(false)
            ]),
            outputSchema: outputSchema,
            annotations: MCPToolAnnotations(
                readOnlyHint: readOnly,
                destructiveHint: destructive,
                idempotentHint: idempotent,
                openWorldHint: openWorld
            )
        )
    }

    private static func string(_ description: String) -> JSONValue {
        .object(["type": .string("string"), "description": .string(description)])
    }

    private static func integer(
        _ description: String, minimum: Int? = nil, maximum: Int? = nil
    ) -> JSONValue {
        var schema: [String: JSONValue] = ["type": .string("integer"), "description": .string(description)]
        if let minimum { schema["minimum"] = .number(Double(minimum)) }
        if let maximum { schema["maximum"] = .number(Double(maximum)) }
        return .object(schema)
    }

    private static func number(
        _ description: String, minimum: Double? = nil, maximum: Double? = nil
    ) -> JSONValue {
        var schema: [String: JSONValue] = ["type": .string("number"), "description": .string(description)]
        if let minimum { schema["minimum"] = .number(minimum) }
        if let maximum { schema["maximum"] = .number(maximum) }
        return .object(schema)
    }

    private static func boolean(_ description: String) -> JSONValue {
        .object(["type": .string("boolean"), "description": .string(description)])
    }

    private static func stringArray(_ description: String) -> JSONValue {
        return .object([
            "type": .string("array"),
            "description": .string(description),
            "items": .object(["type": .string("string")])
        ])
    }

    private static func stringMap(_ description: String) -> JSONValue {
        .object([
            "type": .string("object"),
            "description": .string(description),
            "additionalProperties": .object(["type": .string("string")])
        ])
    }

    private static func enumString(_ values: [String], _ description: String) -> JSONValue {
        .object([
            "type": .string("string"),
            "description": .string(description),
            "enum": .array(values.map(JSONValue.string))
        ])
    }

    private static func type(_ name: String) -> JSONValue {
        .object(["type": .string(name)])
    }

    private static func nullableType(_ name: String) -> JSONValue {
        .object(["type": .array([.string(name), .string("null")])])
    }

    private static func enumType(_ values: [String]) -> JSONValue {
        .object(["type": .string("string"), "enum": .array(values.map(JSONValue.string))])
    }

    private static func objectOutput(
        schemaVersion: String? = nil,
        required: [String],
        properties: [String: JSONValue]
    ) -> JSONValue {
        var successProperties = properties
        if let schemaVersion {
            successProperties["schemaVersion"] = .object(["const": .string(schemaVersion)])
        }
        return .object([
            "type": .string("object"),
            "oneOf": .array([
                .object([
                    "type": .string("object"),
                    "required": .array(required.map(JSONValue.string)),
                    "properties": .object(successProperties),
                    "additionalProperties": .bool(true)
                ]),
                .object([
                    "type": .string("object"),
                    "required": .array([.string("schemaVersion"), .string("error")]),
                    "properties": .object([
                        "schemaVersion": .object(["const": .string("aishell.error.v1")]),
                        "error": .object([
                            "type": .string("object"),
                            "required": .array([.string("code"), .string("message")]),
                            "additionalProperties": .bool(true)
                        ])
                    ]),
                    "additionalProperties": .bool(true)
                ])
            ])
        ])
    }
}
