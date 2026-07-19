import XCTest
@testable import AIShellCore

final class RuntimeStoreTests: XCTestCase {
    func testPersistsConfigurationAndNewestActivityFirst() async throws {
        let fixture = try TemporaryFixture()
        defer { fixture.cleanup() }
        let runtime = fixture.base.appendingPathComponent("runtime", isDirectory: true)
        let allowed = fixture.base.appendingPathComponent("allowed", isDirectory: true)
        try FileManager.default.createDirectory(at: allowed, withIntermediateDirectories: true)
        let store = RuntimeStore(baseDirectory: runtime)

        try await store.setAllowedRoot(allowed)
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
        XCTAssertEqual(configuration.allowedRootPath, allowed.resolvingSymlinksInPath().path)
        XCTAssertTrue(configuration.isPaused)

        let activities = try await store.loadRecentActivities(limit: 10)
        XCTAssertEqual(activities.map(\.operation), ["second", "first"])
    }
}
