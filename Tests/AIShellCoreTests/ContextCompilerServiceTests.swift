import XCTest
@testable import AIShellCore

final class ContextCompilerServiceTests: XCTestCase {
    func testReadContextSharesOneBudgetAndContinuesExplicitly() async throws {
        let fixture = try TemporaryFixture()
        defer { fixture.cleanup() }
        let root = fixture.base.appendingPathComponent("workspace", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        try "first file content\n".write(
            to: root.appendingPathComponent("First.swift"), atomically: true, encoding: .utf8
        )
        try "second file content\n".write(
            to: root.appendingPathComponent("Second.swift"), atomically: true, encoding: .utf8
        )
        let store = RuntimeStore(baseDirectory: fixture.base.appendingPathComponent("runtime"))
        try await store.setAllowedRoot(root)
        let service = ContextCompilerService(runtimeStore: store)

        let first = try await service.readContext(
            targets: ["First.swift", "Second.swift"],
            byteBudget: 20
        )
        XCTAssertEqual(first.chunks.count, 1)
        XCTAssertNotNil(first.continuation)
        XCTAssertGreaterThan(first.omittedBytes, 0)
        XCTAssertFalse(first.chunks[0].sha256.isEmpty)

        let second = try await service.readContext(
            targets: ["First.swift", "Second.swift"],
            byteBudget: 64,
            continuation: first.continuation
        )
        XCTAssertEqual(second.chunks.first?.path, "Second.swift")
        XCTAssertNil(second.continuation)
    }

    func testSearchContextUsesDirectRgWorkerAndReturnsBoundedMatches() async throws {
        let fixture = try TemporaryFixture()
        defer { fixture.cleanup() }
        let root = fixture.base.appendingPathComponent("workspace", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        try "needle one\nother\nneedle two\n".write(
            to: root.appendingPathComponent("Find.swift"), atomically: true, encoding: .utf8
        )
        let store = RuntimeStore(baseDirectory: fixture.base.appendingPathComponent("runtime"))
        try await store.setAllowedRoot(root)
        let service = ContextCompilerService(runtimeStore: store)

        let result = try await service.searchContext(
            query: "needle",
            maxResults: 1,
            byteBudget: 1_024
        )

        XCTAssertEqual(result.matches.count, 1)
        XCTAssertEqual(result.matches[0].path, "Find.swift")
        XCTAssertGreaterThan(result.omittedMatches, 0)
        XCTAssertEqual(result.worker, "rg --json")
    }

    func testSearchContextContinuationRetrievesOmittedMatchesAndRejectsChangedResult() async throws {
        let fixture = try TemporaryFixture()
        defer { fixture.cleanup() }
        let root = fixture.base.appendingPathComponent("workspace", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let file = root.appendingPathComponent("Find.swift")
        try "needle one\nneedle two\nneedle three\n".write(
            to: file, atomically: true, encoding: .utf8
        )
        let store = RuntimeStore(baseDirectory: fixture.base.appendingPathComponent("runtime"))
        try await store.setAllowedRoot(root)
        let service = ContextCompilerService(runtimeStore: store)

        let first = try await service.searchContext(query: "needle", maxResults: 1)
        let second = try await service.searchContext(
            query: "needle", maxResults: 1, continuation: first.continuation
        )
        XCTAssertEqual(first.matches.first?.line, 1)
        XCTAssertEqual(second.matches.first?.line, 2)

        try "needle changed\n".write(to: file, atomically: true, encoding: .utf8)
        do {
            _ = try await service.searchContext(
                query: "needle", maxResults: 1, continuation: second.continuation
            )
            XCTFail("変更後の検索結果を旧cursorで継続しました。")
        } catch {
            guard case AIShellError.contentChanged = error else {
                return XCTFail("想定外のエラー: \(error)")
            }
        }
    }

    func testReadContextRejectsContinuationAfterPartialFileChanges() async throws {
        let fixture = try TemporaryFixture()
        defer { fixture.cleanup() }
        let root = fixture.base.appendingPathComponent("workspace", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let file = root.appendingPathComponent("Changing.swift")
        try "abcdefghij\n".write(to: file, atomically: true, encoding: .utf8)
        let store = RuntimeStore(baseDirectory: fixture.base.appendingPathComponent("runtime"))
        try await store.setAllowedRoot(root)
        let service = ContextCompilerService(runtimeStore: store)

        let first = try await service.readContext(targets: ["Changing.swift"], byteBudget: 5)
        XCTAssertNotNil(first.continuation)
        try "ABCDEFGHIJ\n".write(to: file, atomically: true, encoding: .utf8)

        do {
            _ = try await service.readContext(
                targets: ["Changing.swift"],
                byteBudget: 64,
                continuation: first.continuation
            )
            XCTFail("変更後のfileを旧offsetから黙って継続しました。")
        } catch {
            guard case AIShellError.contentChanged = error else {
                return XCTFail("想定外のエラー: \(error)")
            }
        }
    }

    func testReadContextKeepsUTF8BoundariesAcrossContinuation() async throws {
        let fixture = try TemporaryFixture()
        defer { fixture.cleanup() }
        let root = fixture.base.appendingPathComponent("workspace", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        try "あいうえお".write(
            to: root.appendingPathComponent("Japanese.txt"), atomically: true, encoding: .utf8
        )
        let store = RuntimeStore(baseDirectory: fixture.base.appendingPathComponent("runtime"))
        try await store.setAllowedRoot(root)
        let service = ContextCompilerService(runtimeStore: store)

        let first = try await service.readContext(targets: ["Japanese.txt"], byteBudget: 5)
        let second = try await service.readContext(
            targets: ["Japanese.txt"], byteBudget: 64, continuation: first.continuation
        )

        XCTAssertEqual((first.chunks.first?.text ?? "") + (second.chunks.first?.text ?? ""), "あいうえお")
    }
}
