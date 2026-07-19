import Darwin
import Foundation

public actor NativeProcessService {
    public static let maximumOutputBytes = 1_048_576
    public static let maximumTimeoutSeconds = 3_600.0

    private let store: RuntimeStore

    public init(store: RuntimeStore = RuntimeStore()) {
        self.store = store
    }

    public func run(
        executable: String,
        arguments: [String] = [],
        workingDirectory: String? = nil,
        environment: [String: String] = [:],
        timeoutSeconds: Double = 120
    ) async throws -> ProcessExecutionResult {
        try await audited(operation: "process.run", target: executable) {
            let resolver = try await activeResolver()
            let directory = try resolver.resolveExisting(workingDirectory)
            let values = try directory.resourceValues(forKeys: [.isDirectoryKey])
            guard values.isDirectory == true else {
                throw AIShellError.invalidPath(directory.path)
            }

            let executableURL = try validateExecutable(executable)
            let timeout = min(max(timeoutSeconds, 0.1), Self.maximumTimeoutSeconds)
            return try Self.runSynchronously(
                executableURL: executableURL,
                arguments: arguments,
                workingDirectory: directory,
                environment: environment,
                timeoutSeconds: timeout
            )
        }
    }

    private func activeResolver() async throws -> AllowedPathResolver {
        let configuration = try await store.loadConfiguration()
        guard !configuration.isPaused else { throw AIShellError.paused }
        guard let rootPath = configuration.allowedRootPath else { throw AIShellError.notConfigured }
        return try AllowedPathResolver(rootPath: rootPath)
    }

    private func validateExecutable(_ path: String) throws -> URL {
        guard path.hasPrefix("/") else {
            throw AIShellError.executableNotAllowed("絶対パスを指定してください: \(path)")
        }

        let url = URL(fileURLWithPath: path).standardizedFileURL.resolvingSymlinksInPath()
        let blockedNames: Set<String> = ["sh", "bash", "zsh", "dash", "ksh", "csh", "tcsh", "fish", "env"]
        guard !blockedNames.contains(url.lastPathComponent),
              FileManager.default.isExecutableFile(atPath: url.path) else {
            throw AIShellError.executableNotAllowed(url.path)
        }
        return url
    }

    private nonisolated static func runSynchronously(
        executableURL: URL,
        arguments: [String],
        workingDirectory: URL,
        environment: [String: String],
        timeoutSeconds: Double
    ) throws -> ProcessExecutionResult {
        let scratch = FileManager.default.temporaryDirectory
            .appendingPathComponent("AIShellProcess-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: scratch, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: scratch) }

        let stdoutURL = scratch.appendingPathComponent("stdout")
        let stderrURL = scratch.appendingPathComponent("stderr")
        FileManager.default.createFile(atPath: stdoutURL.path, contents: nil)
        FileManager.default.createFile(atPath: stderrURL.path, contents: nil)
        let stdoutHandle = try FileHandle(forWritingTo: stdoutURL)
        let stderrHandle = try FileHandle(forWritingTo: stderrURL)

        let process = Process()
        process.executableURL = executableURL
        process.arguments = arguments
        process.currentDirectoryURL = workingDirectory
        process.environment = ProcessInfo.processInfo.environment.merging(environment) { _, override in override }
        process.standardOutput = stdoutHandle
        process.standardError = stderrHandle

        let startedAt = Date()
        do {
            try process.run()
        } catch {
            try? stdoutHandle.close()
            try? stderrHandle.close()
            throw AIShellError.processLaunchFailed(error.localizedDescription)
        }

        let deadline = startedAt.addingTimeInterval(timeoutSeconds)
        while process.isRunning && Date() < deadline {
            Thread.sleep(forTimeInterval: 0.02)
        }

        var timedOut = false
        if process.isRunning {
            timedOut = true
            process.terminate()
            let gracefulDeadline = Date().addingTimeInterval(1)
            while process.isRunning && Date() < gracefulDeadline {
                Thread.sleep(forTimeInterval: 0.02)
            }
            if process.isRunning {
                Darwin.kill(process.processIdentifier, SIGKILL)
            }
        }
        process.waitUntilExit()
        try stdoutHandle.close()
        try stderrHandle.close()

        let stdoutRead = try readOutput(from: stdoutURL)
        let stderrRead = try readOutput(from: stderrURL)
        let duration = Int(Date().timeIntervalSince(startedAt) * 1_000)

        return ProcessExecutionResult(
            executable: executableURL.path,
            arguments: arguments,
            workingDirectory: workingDirectory.path,
            exitCode: process.terminationStatus,
            terminationReason: process.terminationReason == .exit ? "exit" : "signal",
            timedOut: timedOut,
            durationMilliseconds: duration,
            stdout: stdoutRead.text,
            stderr: stderrRead.text,
            stdoutTruncated: stdoutRead.truncated,
            stderrTruncated: stderrRead.truncated
        )
    }

    private nonisolated static func readOutput(from url: URL) throws -> (text: String, truncated: Bool) {
        let handle = try FileHandle(forReadingFrom: url)
        defer { try? handle.close() }
        let data = try handle.read(upToCount: maximumOutputBytes + 1) ?? Data()
        let truncated = data.count > maximumOutputBytes
        return (
            String(decoding: data.prefix(maximumOutputBytes), as: UTF8.self),
            truncated
        )
    }

    private func audited<T: Sendable>(
        operation: String,
        target: String,
        body: () async throws -> T
    ) async throws -> T {
        do {
            let result = try await body()
            try? await store.appendActivity(OperationRecord(
                operation: operation,
                target: target,
                success: true,
                message: "完了"
            ))
            return result
        } catch {
            try? await store.appendActivity(OperationRecord(
                operation: operation,
                target: target,
                success: false,
                message: error.localizedDescription
            ))
            throw error
        }
    }
}
