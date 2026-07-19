import XCTest
@testable import AIShellCore

final class FactoryDiagnosticsTests: XCTestCase {
    func testReportsReadinessWithoutLeakingPathsOrActivity() async throws {
        let fixture = try TemporaryFixture()
        defer { fixture.cleanup() }
        let runtime = fixture.base.appendingPathComponent("runtime", isDirectory: true)
        let allowed = fixture.base.appendingPathComponent("secret-project", isDirectory: true)
        let manager = fixture.base.appendingPathComponent("AIShell.app", isDirectory: true)
        try FileManager.default.createDirectory(at: allowed, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: manager, withIntermediateDirectories: true)
        let store = RuntimeStore(baseDirectory: runtime)
        try await store.setAllowedRoot(allowed)
        try await store.appendActivity(OperationRecord(
            operation: "files.read",
            target: allowed.appendingPathComponent("private.txt").path,
            success: true,
            message: "秘密の操作本文"
        ))

        let diagnostics = await FactoryDiagnosticsService(store: store).diagnose(
            managerApplicationURL: manager
        )

        XCTAssertEqual(diagnostics.schemaVersion, "aishell.native_factory_diagnostics.v1")
        XCTAssertEqual(diagnostics.product.identifier, "aishell")
        XCTAssertEqual(diagnostics.product.version, "0.2.1")
        XCTAssertEqual(diagnostics.runtime.configurationState, "valid")
        XCTAssertEqual(diagnostics.runtime.operationReadiness, "ready")
        XCTAssertEqual(diagnostics.runtime.configuredRootCount, 1)
        XCTAssertTrue(diagnostics.manager.ready)
        XCTAssertTrue(diagnostics.ready)
        XCTAssertFalse(diagnostics.privacy.exposesAllowedRootPaths)

        let encoded = String(decoding: try JSONEncoder().encode(diagnostics), as: UTF8.self)
        XCTAssertFalse(encoded.contains(fixture.base.path))
        XCTAssertFalse(encoded.contains("secret-project"))
        XCTAssertFalse(encoded.contains("private.txt"))
        XCTAssertFalse(encoded.contains("秘密の操作本文"))
    }

    func testInvalidConfigurationIsTypedAndDoesNotThrow() async throws {
        let fixture = try TemporaryFixture()
        defer { fixture.cleanup() }
        let runtime = fixture.base.appendingPathComponent("runtime", isDirectory: true)
        let manager = fixture.base.appendingPathComponent("AIShell.app", isDirectory: true)
        try FileManager.default.createDirectory(at: runtime, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: manager, withIntermediateDirectories: true)
        try Data("{invalid".utf8).write(to: runtime.appendingPathComponent("runtime.json"))

        let diagnostics = await FactoryDiagnosticsService(
            store: RuntimeStore(baseDirectory: runtime)
        ).diagnose(managerApplicationURL: manager)

        XCTAssertEqual(diagnostics.runtime.configurationState, "invalid")
        XCTAssertEqual(diagnostics.runtime.migrationStatus, "blocked")
        XCTAssertEqual(diagnostics.runtime.operationReadiness, "invalid_configuration")
        XCTAssertFalse(diagnostics.ready)
        XCTAssertEqual(diagnostics.issues, ["runtime.invalid_configuration"])
    }

    func testPauseIsReportedSeparatelyFromProductReadiness() async throws {
        let fixture = try TemporaryFixture()
        defer { fixture.cleanup() }
        let runtime = fixture.base.appendingPathComponent("runtime", isDirectory: true)
        let allowed = fixture.base.appendingPathComponent("allowed", isDirectory: true)
        let manager = fixture.base.appendingPathComponent("AIShell.app", isDirectory: true)
        try FileManager.default.createDirectory(at: allowed, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: manager, withIntermediateDirectories: true)
        let store = RuntimeStore(baseDirectory: runtime)
        try await store.setAllowedRoot(allowed)
        try await store.setPaused(true)

        let diagnostics = await FactoryDiagnosticsService(store: store).diagnose(
            managerApplicationURL: manager
        )

        XCTAssertEqual(diagnostics.runtime.operationReadiness, "paused")
        XCTAssertEqual(diagnostics.runtime.isPaused, true)
        XCTAssertTrue(diagnostics.ready)
    }
}
