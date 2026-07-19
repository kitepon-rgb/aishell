import XCTest
@testable import AIShellCore

final class WorkspaceStateRuntimeTests: XCTestCase {
    func testInitialSnapshotThenObservedDeltaWithoutSilentFullScan() async throws {
        let fixture = try TemporaryFixture()
        defer { fixture.cleanup() }
        let root = fixture.base.appendingPathComponent("workspace", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let file = root.appendingPathComponent("Sources/App.swift")
        try FileManager.default.createDirectory(
            at: file.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        try "let value = 1\n".write(to: file, atomically: true, encoding: .utf8)
        let otherFile = root.appendingPathComponent("Sources/Other.swift")
        try "let other = 1\n".write(to: otherFile, atomically: true, encoding: .utf8)
        let store = RuntimeStore(baseDirectory: fixture.base.appendingPathComponent("runtime"))
        try await store.setAllowedRoot(root)
        let runtime = WorkspaceStateRuntime(runtimeStore: store, startsFSEvents: false)

        let initial = try await runtime.snapshot(entryLimit: 100)
        let scanCount = await runtime.scanInvocationCountForTests()
        XCTAssertTrue(initial.isFull)
        XCTAssertEqual(scanCount, 1)
        XCTAssertTrue(initial.entries.contains { $0.path == "Sources/App.swift" })
        XCTAssertTrue(initial.context.contains { $0.path == "Sources/App.swift" && $0.text.contains("value = 1") })

        try "let value = 2\n".write(to: file, atomically: true, encoding: .utf8)
        await runtime.ingestObservedPaths([file.path])
        let delta = try await runtime.snapshot(sinceCursor: initial.cursor, entryLimit: 100)

        XCTAssertFalse(delta.isFull)
        XCTAssertEqual(delta.changes.count, 1)
        XCTAssertEqual(delta.changes.first?.kind, .modified)
        XCTAssertEqual(delta.changes.first?.path, "Sources/App.swift")
        XCTAssertTrue(delta.context.first?.text.contains("value = 2") == true)

        let renamedFile = root.appendingPathComponent("Sources/Renamed.swift")
        try FileManager.default.moveItem(at: file, to: renamedFile)
        try "let other = 2\n".write(to: otherFile, atomically: true, encoding: .utf8)
        await runtime.ingestObservedPaths([file.path, otherFile.path, renamedFile.path])
        let renamed = try await runtime.snapshot(sinceCursor: delta.cursor, entryLimit: 1)
        let renameChange = try XCTUnwrap(renamed.changes.first { $0.kind == .renamed })
        XCTAssertEqual(renameChange.path, "Sources/Renamed.swift")
        XCTAssertEqual(renameChange.previousPath, "Sources/App.swift")

        try FileManager.default.removeItem(at: renamedFile)
        await runtime.ingestObservedPaths([renamedFile.path])
        let deleted = try await runtime.snapshot(sinceCursor: renamed.cursor, entryLimit: 100)
        XCTAssertEqual(deleted.changes.first?.kind, .deleted)
    }

    func testGapRequiresExplicitRescan() async throws {
        let fixture = try TemporaryFixture()
        defer { fixture.cleanup() }
        let root = fixture.base.appendingPathComponent("workspace", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let store = RuntimeStore(baseDirectory: fixture.base.appendingPathComponent("runtime"))
        try await store.setAllowedRoot(root)
        let runtime = WorkspaceStateRuntime(runtimeStore: store, startsFSEvents: false)
        let initial = try await runtime.snapshot()
        let changed = root.appendingPathComponent("Recovered.swift")
        try "let recovered = true\n".write(to: changed, atomically: true, encoding: .utf8)
        await runtime.markRescanRequired(reason: "event stream dropped")

        do {
            _ = try await runtime.snapshot(sinceCursor: initial.cursor)
            XCTFail("gap後に黙ってfull scanしました。")
        } catch {
            guard case AIShellError.rescanRequired = error else {
                return XCTFail("想定外のエラー: \(error)")
            }
        }

        let recovered = try await runtime.snapshot()
        let scanCount = await runtime.scanInvocationCountForTests()
        XCTAssertTrue(recovered.isFull)
        XCTAssertTrue(recovered.entries.contains { $0.path == "Recovered.swift" })
        XCTAssertEqual(scanCount, 2)
    }

    func testImmediateDeltaAllowsFSEventsDeliveryBeforeReturningEmpty() async throws {
        let fixture = try TemporaryFixture()
        defer { fixture.cleanup() }
        let root = fixture.base.appendingPathComponent("workspace", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let file = root.appendingPathComponent("State.txt")
        try "before\n".write(to: file, atomically: true, encoding: .utf8)
        let store = RuntimeStore(baseDirectory: fixture.base.appendingPathComponent("runtime"))
        try await store.setAllowedRoot(root)
        let runtime = WorkspaceStateRuntime(runtimeStore: store)
        let initial = try await runtime.snapshot()

        try "after\n".write(to: file, atomically: true, encoding: .utf8)
        let delta = try await runtime.snapshot(sinceCursor: initial.cursor)

        XCTAssertTrue(delta.changes.contains { $0.path == "State.txt" && $0.kind == .modified })
        XCTAssertTrue(delta.context.contains { $0.path == "State.txt" && $0.text == "after\n" })
    }

    func testSnapshotDoesNotReadEscapingSymlinkContent() async throws {
        let fixture = try TemporaryFixture()
        defer { fixture.cleanup() }
        let root = fixture.base.appendingPathComponent("workspace", isDirectory: true)
        let outside = fixture.base.appendingPathComponent("outside.txt")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        try "outside secret\n".write(to: outside, atomically: true, encoding: .utf8)
        try FileManager.default.createSymbolicLink(
            at: root.appendingPathComponent("linked.txt"),
            withDestinationURL: outside
        )
        let store = RuntimeStore(baseDirectory: fixture.base.appendingPathComponent("runtime"))
        try await store.setAllowedRoot(root)
        let runtime = WorkspaceStateRuntime(runtimeStore: store, startsFSEvents: false)

        let snapshot = try await runtime.snapshot()

        XCTAssertFalse(snapshot.entries.contains { $0.path == "linked.txt" })
        XCTAssertFalse(snapshot.context.contains { $0.text.contains("outside secret") })
    }

    func testSnapshotIncludesRelevantHiddenDevelopmentFiles() async throws {
        let fixture = try TemporaryFixture()
        defer { fixture.cleanup() }
        let root = fixture.base.appendingPathComponent("workspace", isDirectory: true)
        let github = root.appendingPathComponent(".github")
        try FileManager.default.createDirectory(at: github, withIntermediateDirectories: true)
        try Data("name: ci\n".utf8).write(to: github.appendingPathComponent("workflow.yml"))
        let store = RuntimeStore(baseDirectory: fixture.base.appendingPathComponent("runtime"))
        try await store.setAllowedRoot(root)
        let runtime = WorkspaceStateRuntime(runtimeStore: store, startsFSEvents: false)

        let snapshot = try await runtime.snapshot(entryLimit: 100)

        XCTAssertTrue(snapshot.entries.contains { $0.path == ".github/workflow.yml" })
    }

    func testDeltaCursorDoesNotSkipChangesPastEntryLimit() async throws {
        let fixture = try TemporaryFixture()
        defer { fixture.cleanup() }
        let root = fixture.base.appendingPathComponent("workspace", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let files = ["A.txt", "B.txt", "C.txt"].map { root.appendingPathComponent($0) }
        for file in files { try "before\n".write(to: file, atomically: true, encoding: .utf8) }
        let store = RuntimeStore(baseDirectory: fixture.base.appendingPathComponent("runtime"))
        try await store.setAllowedRoot(root)
        let runtime = WorkspaceStateRuntime(runtimeStore: store, startsFSEvents: false)
        let initial = try await runtime.snapshot()
        for file in files { try "after\n".write(to: file, atomically: true, encoding: .utf8) }
        await runtime.ingestObservedPaths(files.map(\.path))

        let first = try await runtime.snapshot(sinceCursor: initial.cursor, entryLimit: 1)
        let second = try await runtime.snapshot(sinceCursor: first.cursor, entryLimit: 1)
        let third = try await runtime.snapshot(sinceCursor: second.cursor, entryLimit: 1)
        let observed = Set((first.changes + second.changes + third.changes).map(\.path))

        XCTAssertEqual(observed, Set(["A.txt", "B.txt", "C.txt"]))
        XCTAssertGreaterThan(first.omittedEntries, 0)
        XCTAssertEqual(third.omittedEntries, 0)
    }

    func testDirectoryRenameReconcilesDescendantPaths() async throws {
        let fixture = try TemporaryFixture()
        defer { fixture.cleanup() }
        let root = fixture.base.appendingPathComponent("workspace", isDirectory: true)
        let oldDirectory = root.appendingPathComponent("Dir", isDirectory: true)
        let newDirectory = root.appendingPathComponent("Moved", isDirectory: true)
        try FileManager.default.createDirectory(at: oldDirectory, withIntermediateDirectories: true)
        try "child\n".write(
            to: oldDirectory.appendingPathComponent("Child.swift"), atomically: true, encoding: .utf8
        )
        let store = RuntimeStore(baseDirectory: fixture.base.appendingPathComponent("runtime"))
        try await store.setAllowedRoot(root)
        let runtime = WorkspaceStateRuntime(runtimeStore: store, startsFSEvents: false)
        let initial = try await runtime.snapshot()

        try FileManager.default.moveItem(at: oldDirectory, to: newDirectory)
        await runtime.ingestObservedPaths([oldDirectory.path, newDirectory.path])
        let delta = try await runtime.snapshot(sinceCursor: initial.cursor, entryLimit: 1)

        XCTAssertTrue(delta.changes.contains {
            $0.kind == .renamed && $0.path == "Moved/Child.swift" && $0.previousPath == "Dir/Child.swift"
        })
    }
}
