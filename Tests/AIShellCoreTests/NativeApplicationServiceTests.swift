import XCTest
@testable import AIShellCore

@MainActor
final class NativeApplicationServiceTests: XCTestCase {
    func testListsRunningApplicationsThroughNSWorkspace() async throws {
        let fixture = try TemporaryFixture()
        defer { fixture.cleanup() }
        let store = RuntimeStore(baseDirectory: fixture.base.appendingPathComponent("runtime"))
        let service = NativeApplicationService(store: store)

        let applications = try await service.listRunningApplications()

        XCTAssertFalse(applications.isEmpty)
        XCTAssertTrue(applications.allSatisfy { $0.processIdentifier > 0 })
    }
}
