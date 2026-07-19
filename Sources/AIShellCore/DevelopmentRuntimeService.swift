import Foundation

public actor DevelopmentRuntimeService {
    private let processes: NativeProcessService
    public nonisolated let evidenceStore: EvidenceStore
    public nonisolated let workspaceRuntime: WorkspaceStateRuntime
    private let contextCompiler: ContextCompilerService

    public init(
        runtimeStore: RuntimeStore = RuntimeStore(),
        evidenceStore: EvidenceStore? = nil,
        workspaceRuntime: WorkspaceStateRuntime? = nil
    ) {
        processes = NativeProcessService(store: runtimeStore)
        self.evidenceStore = evidenceStore ?? EvidenceStore(
            baseDirectory: runtimeStore.baseDirectory.appendingPathComponent("evidence", isDirectory: true)
        )
        let workspace = workspaceRuntime ?? WorkspaceStateRuntime(runtimeStore: runtimeStore)
        self.workspaceRuntime = workspace
        contextCompiler = ContextCompilerService(runtimeStore: runtimeStore, workspaceRuntime: workspace)
    }

    public func runCheck(
        executable: String,
        arguments: [String] = [],
        workingDirectory: String? = nil,
        environment: [String: String] = [:],
        timeoutSeconds: Double = 120,
        retentionSeconds: TimeInterval = EvidenceStore.defaultRetentionSeconds
    ) async throws -> RunCheckResult {
        let requestID = "req_" + UUID().uuidString.replacingOccurrences(of: "-", with: "").lowercased()
        let execution = try await processes.runRetained(
            executable: executable,
            arguments: arguments,
            workingDirectory: workingDirectory,
            environment: environment,
            timeoutSeconds: timeoutSeconds,
            evidenceStore: evidenceStore,
            retentionSeconds: retentionSeconds
        )

        let status: RunCheckStatus
        if execution.timedOut {
            status = .timedOut
        } else if execution.exitCode == 0 {
            status = .passed
        } else {
            status = .failed
        }
        let diagnostic = try await primaryDiagnostic(for: execution)
        let summary: String
        switch status {
        case .passed:
            summary = "成功: exit 0"
        case .failed:
            summary = diagnostic.map { "失敗: \($0)" } ?? "失敗: exit \(execution.exitCode)"
        case .timedOut:
            summary = "timeout: \(execution.durationMilliseconds)ms"
        }

        return RunCheckResult(
            schemaVersion: "aishell.run-check.v1",
            requestID: requestID,
            status: status,
            summary: summary,
            primaryDiagnostic: diagnostic,
            exitCode: execution.exitCode,
            timedOut: execution.timedOut,
            durationMilliseconds: execution.durationMilliseconds,
            stdoutArtifact: execution.stdoutArtifact,
            stderrArtifact: execution.stderrArtifact
        )
    }

    public func readArtifact(
        handle: String,
        mode: ArtifactReadMode = .range(offset: 0, length: 65_536),
        byteBudget: Int = 65_536
    ) async throws -> ArtifactSlice {
        try await evidenceStore.read(handle: handle, mode: mode, byteBudget: byteBudget)
    }

    public func workspaceSnapshot(
        path: String? = nil,
        sinceCursor: String? = nil,
        entryLimit: Int = 500,
        contextBudget: Int = 16_384
    ) async throws -> WorkspaceSnapshot {
        try await workspaceRuntime.snapshot(
            path: path,
            sinceCursor: sinceCursor,
            entryLimit: entryLimit,
            contextBudget: contextBudget
        )
    }

    public func readContext(
        targets: [String],
        byteBudget: Int = 65_536,
        continuation: String? = nil
    ) async throws -> ReadContextResult {
        try await contextCompiler.readContext(
            targets: targets,
            byteBudget: byteBudget,
            continuation: continuation
        )
    }

    public func searchContext(
        query: String,
        path: String? = nil,
        maxResults: Int = 50,
        byteBudget: Int = 65_536,
        continuation: String? = nil
    ) async throws -> SearchContextResult {
        try await contextCompiler.searchContext(
            query: query,
            path: path,
            maxResults: maxResults,
            byteBudget: byteBudget,
            continuation: continuation
        )
    }

    private func primaryDiagnostic(for execution: RetainedProcessExecution) async throws -> String? {
        let stderrSamples = try await artifactSamples(execution.stderrArtifact)
        let stdoutSamples = try await artifactSamples(execution.stdoutArtifact)
        let samples = stderrSamples + stdoutSamples
        for text in samples {
            if let diagnostic = diagnosticLine(in: text) { return diagnostic }
        }
        return samples.lazy.flatMap { $0.split(whereSeparator: { $0.isNewline }).map(String.init) }
            .first(where: { !$0.trimmingCharacters(in: .whitespaces).isEmpty })
    }

    private func artifactSamples(_ artifact: ArtifactMetadata) async throws -> [String] {
        guard artifact.sizeBytes > 0 else { return [] }
        let head = try await evidenceStore.read(
            handle: artifact.handle,
            mode: .range(offset: 0, length: 65_536),
            byteBudget: 65_536
        )
        var samples = head.text.map { [$0] } ?? []
        if artifact.sizeBytes > head.returnedBytes {
            let tail = try await evidenceStore.read(
                handle: artifact.handle,
                mode: .tail(lines: 500),
                byteBudget: 65_536
            )
            if let text = tail.text { samples.append(text) }
        }
        return samples
    }

    private func diagnosticLine(in text: String) -> String? {
        let lines = text.split(whereSeparator: { $0.isNewline }).map(String.init)
        return lines.first(where: {
            $0.localizedCaseInsensitiveContains("error:")
                || $0.localizedCaseInsensitiveContains("fatal error")
                || $0.localizedCaseInsensitiveContains("syntaxerror")
        })
    }
}
