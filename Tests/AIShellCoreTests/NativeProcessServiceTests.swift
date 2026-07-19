import XCTest
@testable import AIShellCore

final class NativeProcessServiceTests: XCTestCase {
    func testRunsExecutableDirectlyAndCapturesStructuredResult() async throws {
        let fixture = try TemporaryFixture()
        defer { fixture.cleanup() }
        let runtime = fixture.base.appendingPathComponent("runtime", isDirectory: true)
        let allowed = fixture.base.appendingPathComponent("allowed", isDirectory: true)
        try FileManager.default.createDirectory(at: allowed, withIntermediateDirectories: true)
        let store = RuntimeStore(baseDirectory: runtime)
        try await store.setAllowedRoot(allowed)
        let service = NativeProcessService(store: store)

        let result = try await service.run(
            executable: "/usr/bin/printf",
            arguments: ["%s", "direct-process"],
            workingDirectory: ".",
            environment: ["AISHELL_TEST": "1"],
            timeoutSeconds: 5
        )

        XCTAssertEqual(result.exitCode, 0)
        XCTAssertEqual(result.terminationReason, "exit")
        XCTAssertFalse(result.timedOut)
        XCTAssertEqual(result.stdout, "direct-process")
        XCTAssertEqual(result.stderr, "")
        XCTAssertEqual(result.workingDirectory, allowed.path)
    }

    func testTimeoutTerminatesProcess() async throws {
        let fixture = try TemporaryFixture()
        defer { fixture.cleanup() }
        let allowed = fixture.base.appendingPathComponent("allowed", isDirectory: true)
        try FileManager.default.createDirectory(at: allowed, withIntermediateDirectories: true)
        let store = RuntimeStore(baseDirectory: fixture.base.appendingPathComponent("runtime"))
        try await store.setAllowedRoot(allowed)
        let service = NativeProcessService(store: store)

        let result = try await service.run(
            executable: "/bin/sleep",
            arguments: ["2"],
            timeoutSeconds: 0.1
        )

        XCTAssertTrue(result.timedOut)
        XCTAssertEqual(result.terminationReason, "signal")
    }

    func testRunsWithSecondAllowedRootAsAbsoluteWorkingDirectory() async throws {
        let fixture = try TemporaryFixture()
        defer { fixture.cleanup() }
        let first = fixture.base.appendingPathComponent("first", isDirectory: true)
        let second = fixture.base.appendingPathComponent("second", isDirectory: true)
        try FileManager.default.createDirectory(at: first, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: second, withIntermediateDirectories: true)
        let store = RuntimeStore(baseDirectory: fixture.base.appendingPathComponent("runtime"))
        try await store.setAllowedRoots([first, second])
        let service = NativeProcessService(store: store)

        let result = try await service.run(
            executable: "/bin/pwd",
            workingDirectory: second.path
        )
        let canonicalSecond = second.resolvingSymlinksInPath().path
        XCTAssertEqual(result.exitCode, 0)
        XCTAssertEqual(result.workingDirectory, canonicalSecond)
        XCTAssertTrue(result.stdout.trimmingCharacters(in: .whitespacesAndNewlines).hasSuffix("/second"))
    }

    func testRejectsShellAndWorkingDirectoryOutsideRoot() async throws {
        let fixture = try TemporaryFixture()
        defer { fixture.cleanup() }
        let allowed = fixture.base.appendingPathComponent("allowed", isDirectory: true)
        let outside = fixture.base.appendingPathComponent("outside", isDirectory: true)
        try FileManager.default.createDirectory(at: allowed, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: outside, withIntermediateDirectories: true)
        let store = RuntimeStore(baseDirectory: fixture.base.appendingPathComponent("runtime"))
        try await store.setAllowedRoot(allowed)
        let service = NativeProcessService(store: store)

        do {
            _ = try await service.run(executable: "/bin/zsh", arguments: ["-c", "true"])
            XCTFail("shellを直接起動してしまいました。")
        } catch {
            guard case AIShellError.executableNotAllowed = error else {
                return XCTFail("想定外のエラー: \(error)")
            }
        }

        do {
            _ = try await service.run(
                executable: "/usr/bin/true",
                workingDirectory: outside.path
            )
            XCTFail("許可ルート外をworking directoryにしてしまいました。")
        } catch {
            guard case AIShellError.outsideAllowedRoot = error else {
                return XCTFail("想定外のエラー: \(error)")
            }
        }
    }
}
