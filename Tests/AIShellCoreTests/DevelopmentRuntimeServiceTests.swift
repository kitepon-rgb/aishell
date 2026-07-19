import XCTest
@testable import AIShellCore

final class DevelopmentRuntimeServiceTests: XCTestCase {
    func testRunCheckReturnsSmallSummaryAndRetainedStreams() async throws {
        let fixture = try TemporaryFixture()
        defer { fixture.cleanup() }
        let allowed = fixture.base.appendingPathComponent("allowed", isDirectory: true)
        try FileManager.default.createDirectory(at: allowed, withIntermediateDirectories: true)
        let runtimeStore = RuntimeStore(baseDirectory: fixture.base.appendingPathComponent("runtime"))
        try await runtimeStore.setAllowedRoot(allowed)
        let evidenceStore = EvidenceStore(baseDirectory: fixture.base.appendingPathComponent("evidence"))
        let service = DevelopmentRuntimeService(runtimeStore: runtimeStore, evidenceStore: evidenceStore)

        let result = try await service.runCheck(
            executable: "/usr/bin/printf",
            arguments: ["%s", "direct-check"],
            workingDirectory: ".",
            timeoutSeconds: 5
        )

        XCTAssertEqual(result.status, .passed)
        XCTAssertEqual(result.exitCode, 0)
        XCTAssertEqual(result.summary, "成功: exit 0")
        XCTAssertLessThan(result.summary.utf8.count, 128)
        let stdout = try await evidenceStore.read(
            handle: result.stdoutArtifact.handle,
            mode: .range(offset: 0, length: 1_024),
            byteBudget: 1_024
        )
        XCTAssertEqual(stdout.text, "direct-check")
    }

    func testRunCheckExtractsPrimaryDiagnosticAndKeepsCompleteLog() async throws {
        let fixture = try TemporaryFixture()
        defer { fixture.cleanup() }
        let allowed = fixture.base.appendingPathComponent("allowed", isDirectory: true)
        try FileManager.default.createDirectory(at: allowed, withIntermediateDirectories: true)
        let runtimeStore = RuntimeStore(baseDirectory: fixture.base.appendingPathComponent("runtime"))
        try await runtimeStore.setAllowedRoot(allowed)
        let evidenceStore = EvidenceStore(baseDirectory: fixture.base.appendingPathComponent("evidence"))
        let service = DevelopmentRuntimeService(runtimeStore: runtimeStore, evidenceStore: evidenceStore)

        let result = try await service.runCheck(
            executable: "/usr/bin/false",
            workingDirectory: ".",
            timeoutSeconds: 5
        )

        XCTAssertEqual(result.status, .failed)
        XCTAssertEqual(result.exitCode, 1)
        XCTAssertNotNil(result.stderrArtifact.handle)
        XCTAssertTrue(result.summary.contains("失敗"))
    }

    func testRunCheckFindsPrimaryDiagnosticAtTailOfLargeLog() async throws {
        let fixture = try TemporaryFixture()
        defer { fixture.cleanup() }
        let allowed = fixture.base.appendingPathComponent("allowed", isDirectory: true)
        try FileManager.default.createDirectory(at: allowed, withIntermediateDirectories: true)
        let runtimeStore = RuntimeStore(baseDirectory: fixture.base.appendingPathComponent("runtime"))
        try await runtimeStore.setAllowedRoot(allowed)
        let evidenceStore = EvidenceStore(baseDirectory: fixture.base.appendingPathComponent("evidence"))
        let service = DevelopmentRuntimeService(runtimeStore: runtimeStore, evidenceStore: evidenceStore)

        let result = try await service.runCheck(
            executable: "/usr/bin/awk",
            arguments: [
                "BEGIN { for (i = 0; i < 4000; i++) print \"dependency diagnostic padding padding padding\" > \"/dev/stderr\"; print \"SyntaxError: primary failure\" > \"/dev/stderr\"; exit 1 }"
            ],
            workingDirectory: ".",
            timeoutSeconds: 5
        )

        XCTAssertEqual(result.status, .failed)
        XCTAssertEqual(result.primaryDiagnostic, "SyntaxError: primary failure")
        XCTAssertGreaterThan(result.stderrArtifact.sizeBytes, 65_536)
    }
}
