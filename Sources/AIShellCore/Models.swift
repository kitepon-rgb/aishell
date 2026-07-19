import Foundation

public struct RuntimeConfiguration: Codable, Equatable, Sendable {
    public var allowedRootPaths: [String]
    public var isPaused: Bool
    public var updatedAt: Date

    public init(
        allowedRootPaths: [String] = [],
        isPaused: Bool = false,
        updatedAt: Date = Date()
    ) {
        self.allowedRootPaths = allowedRootPaths
        self.isPaused = isPaused
        self.updatedAt = updatedAt
    }

    public var primaryAllowedRootPath: String? {
        allowedRootPaths.first
    }

    private enum CodingKeys: String, CodingKey {
        case allowedRootPaths
        case allowedRootPath
        case isPaused
        case updatedAt
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        if let paths = try container.decodeIfPresent([String].self, forKey: .allowedRootPaths) {
            allowedRootPaths = paths
        } else if let legacyPath = try container.decodeIfPresent(String.self, forKey: .allowedRootPath) {
            allowedRootPaths = [legacyPath]
        } else {
            allowedRootPaths = []
        }
        isPaused = try container.decodeIfPresent(Bool.self, forKey: .isPaused) ?? false
        updatedAt = try container.decodeIfPresent(Date.self, forKey: .updatedAt) ?? Date()
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(allowedRootPaths, forKey: .allowedRootPaths)
        try container.encode(isPaused, forKey: .isPaused)
        try container.encode(updatedAt, forKey: .updatedAt)
    }
}

public struct OperationRecord: Codable, Equatable, Identifiable, Sendable {
    public let id: UUID
    public let timestamp: Date
    public let operation: String
    public let target: String
    public let success: Bool
    public let message: String

    public init(
        id: UUID = UUID(),
        timestamp: Date = Date(),
        operation: String,
        target: String,
        success: Bool,
        message: String
    ) {
        self.id = id
        self.timestamp = timestamp
        self.operation = operation
        self.target = target
        self.success = success
        self.message = message
    }
}

public struct FileEntry: Codable, Equatable, Sendable {
    public let name: String
    public let path: String
    public let isDirectory: Bool
    public let size: Int64?
    public let modifiedAt: Date?

    public init(
        name: String,
        path: String,
        isDirectory: Bool,
        size: Int64?,
        modifiedAt: Date?
    ) {
        self.name = name
        self.path = path
        self.isDirectory = isDirectory
        self.size = size
        self.modifiedAt = modifiedAt
    }
}

public struct FileStat: Codable, Equatable, Sendable {
    public let entry: FileEntry
    public let sha256: String?
    public let posixPermissions: Int?

    public init(entry: FileEntry, sha256: String?, posixPermissions: Int?) {
        self.entry = entry
        self.sha256 = sha256
        self.posixPermissions = posixPermissions
    }
}

public struct FileTreeEntry: Codable, Equatable, Sendable {
    public let depth: Int
    public let entry: FileEntry

    public init(depth: Int, entry: FileEntry) {
        self.depth = depth
        self.entry = entry
    }
}

public struct ProcessExecutionResult: Codable, Equatable, Sendable {
    public let executable: String
    public let arguments: [String]
    public let workingDirectory: String
    public let exitCode: Int32
    public let terminationReason: String
    public let timedOut: Bool
    public let durationMilliseconds: Int
    public let stdout: String
    public let stderr: String
    public let stdoutTruncated: Bool
    public let stderrTruncated: Bool

    public init(
        executable: String,
        arguments: [String],
        workingDirectory: String,
        exitCode: Int32,
        terminationReason: String,
        timedOut: Bool,
        durationMilliseconds: Int,
        stdout: String,
        stderr: String,
        stdoutTruncated: Bool,
        stderrTruncated: Bool
    ) {
        self.executable = executable
        self.arguments = arguments
        self.workingDirectory = workingDirectory
        self.exitCode = exitCode
        self.terminationReason = terminationReason
        self.timedOut = timedOut
        self.durationMilliseconds = durationMilliseconds
        self.stdout = stdout
        self.stderr = stderr
        self.stdoutTruncated = stdoutTruncated
        self.stderrTruncated = stderrTruncated
    }
}

public struct RunningApplicationInfo: Codable, Equatable, Sendable {
    public let name: String
    public let bundleIdentifier: String?
    public let processIdentifier: Int32
    public let isActive: Bool

    public init(
        name: String,
        bundleIdentifier: String?,
        processIdentifier: Int32,
        isActive: Bool
    ) {
        self.name = name
        self.bundleIdentifier = bundleIdentifier
        self.processIdentifier = processIdentifier
        self.isActive = isActive
    }
}

public struct InstalledApplicationInfo: Codable, Equatable, Sendable {
    public let name: String
    public let bundleIdentifier: String?
    public let path: String

    public init(name: String, bundleIdentifier: String?, path: String) {
        self.name = name
        self.bundleIdentifier = bundleIdentifier
        self.path = path
    }
}

public enum AIShellError: LocalizedError, Equatable, Sendable {
    case notConfigured
    case paused
    case outsideAllowedRoot(String)
    case invalidPath(String)
    case itemAlreadyExists(String)
    case itemNotFound(String)
    case notTextFile(String)
    case textFileTooLarge(Int)
    case applicationNotFound(String)
    case applicationActivationFailed(String)
    case contentChanged(String)
    case executableNotAllowed(String)
    case processLaunchFailed(String)
    case invalidArgument(String)

    public var errorDescription: String? {
        switch self {
        case .notConfigured:
            "許可rootがありません。runtime_open_managerでAIShellを開き、操作対象フォルダを追加してください。"
        case .paused:
            "AI操作は停止中です。runtime_open_managerでAIShellを開き、管理画面で再開してください。"
        case let .outsideAllowedRoot(path):
            "許可root外のため操作できません: \(path)。runtime_open_managerで対象rootを追加してください。"
        case let .invalidPath(path):
            "パスが不正です: \(path)"
        case let .itemAlreadyExists(path):
            "既に項目が存在します: \(path)"
        case let .itemNotFound(path):
            "項目が見つかりません: \(path)"
        case let .notTextFile(path):
            "UTF-8テキストとして読み取れません: \(path)"
        case let .textFileTooLarge(limit):
            "テキストファイルが上限（\(limit) bytes）を超えています。"
        case let .applicationNotFound(identifier):
            "アプリが見つかりません: \(identifier)"
        case let .applicationActivationFailed(identifier):
            "アプリを前面化できません: \(identifier)"
        case let .contentChanged(path):
            "読み取り後に内容が変わったため更新を中止しました: \(path)"
        case let .executableNotAllowed(path):
            "直接実行できないプログラムです: \(path)"
        case let .processLaunchFailed(message):
            "プログラムを起動できません: \(message)"
        case let .invalidArgument(message):
            "引数が不正です: \(message)"
        }
    }
}
