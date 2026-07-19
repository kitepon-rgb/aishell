import XCTest
@testable import AIShellCore

final class RuntimeStoreTests: XCTestCase {
    func testPersistsConfigurationAndNewestActivityFirst() async throws {
        let fixture = try TemporaryFixture()
        defer { fixture.cleanup() }
        let runtime = fixture.base.appendingPathComponent("runtime", isDirectory: true)
        let allowed = fixture.base.appendingPathComponent("allowed", isDirectory: true)
        let second = fixture.base.appendingPathComponent("second", isDirectory: true)
        try FileManager.default.createDirectory(at: allowed, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: second, withIntermediateDirectories: true)
        let store = RuntimeStore(baseDirectory: runtime)

        try await store.setAllowedRoots([allowed, second, allowed])
        try await store.setPaused(true)
        try await store.appendActivity(OperationRecord(
            operation: "first",
            target: "a",
            success: true,
            message: "完了"
        ))
        try await store.appendActivity(OperationRecord(
            operation: "second",
            target: "b",
            success: false,
            message: "失敗"
        ))

        let configuration = try await store.loadConfiguration()
        XCTAssertEqual(configuration.allowedRootPaths, [
            allowed.resolvingSymlinksInPath().path,
            second.resolvingSymlinksInPath().path
        ])
        XCTAssertEqual(configuration.primaryAllowedRootPath, allowed.resolvingSymlinksInPath().path)
        XCTAssertTrue(configuration.isPaused)

        let activities = try await store.loadRecentActivities(limit: 10)
        XCTAssertEqual(activities.map(\.operation), ["second", "first"])
    }

    func testAddsRemovesAndMigratesLegacySingleRootConfiguration() async throws {
        let fixture = try TemporaryFixture()
        defer { fixture.cleanup() }
        let runtime = fixture.base.appendingPathComponent("runtime", isDirectory: true)
        let first = fixture.base.appendingPathComponent("first", isDirectory: true)
        let second = fixture.base.appendingPathComponent("second", isDirectory: true)
        try FileManager.default.createDirectory(at: runtime, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: first, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: second, withIntermediateDirectories: true)
        let legacy = """
        {"allowedRootPath":"\(first.path)","isPaused":true,"updatedAt":"2026-07-19T00:00:00Z"}
        """
        try Data(legacy.utf8).write(to: runtime.appendingPathComponent("runtime.json"))
        let store = RuntimeStore(baseDirectory: runtime)

        let migrated = try await store.loadConfiguration()
        XCTAssertEqual(migrated.allowedRootPaths, [first.path])
        XCTAssertTrue(migrated.isPaused)

        _ = try await store.addAllowedRoots([second, first])
        var updated = try await store.loadConfiguration()
        XCTAssertEqual(updated.allowedRootPaths, [first.path, second.path])

        _ = try await store.removeAllowedRoot(path: first.path)
        updated = try await store.loadConfiguration()
        XCTAssertEqual(updated.allowedRootPaths, [second.path])
    }
}
