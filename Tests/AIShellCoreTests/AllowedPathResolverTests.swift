import XCTest
@testable import AIShellCore

final class AllowedPathResolverTests: XCTestCase {
    func testRejectsParentTraversalAndEscapingSymlink() throws {
        let fixture = try TemporaryFixture()
        defer { fixture.cleanup() }
        let outside = fixture.base.appendingPathComponent("outside", isDirectory: true)
        let root = fixture.base.appendingPathComponent("allowed", isDirectory: true)
        try FileManager.default.createDirectory(at: outside, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        try Data("secret".utf8).write(to: outside.appendingPathComponent("secret.txt"))
        try FileManager.default.createSymbolicLink(
            at: root.appendingPathComponent("escape"),
            withDestinationURL: outside
        )

        let resolver = try AllowedPathResolver(rootPath: root.path)

        XCTAssertThrowsError(try resolver.resolveDestination("../outside/new.txt")) { error in
            guard case AIShellError.outsideAllowedRoot = error else {
                return XCTFail("想定外のエラー: \(error)")
            }
        }

        XCTAssertThrowsError(try resolver.resolveExisting("escape/secret.txt")) { error in
            guard case AIShellError.outsideAllowedRoot = error else {
                return XCTFail("想定外のエラー: \(error)")
            }
        }

        XCTAssertThrowsError(try resolver.resolveDestination("escape/new.txt")) { error in
            guard case AIShellError.outsideAllowedRoot = error else {
                return XCTFail("想定外のエラー: \(error)")
            }
        }
    }
}
