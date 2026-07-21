import CoreServices
import XCTest
@testable import AIShellCore

final class WorkspaceStateRuntimeTests: XCTestCase {
    func testSearchObservationReplaysWithoutConsumingSnapshotJournal() async throws {
        let fixture = try TemporaryFixture()
        defer { fixture.cleanup() }
        let root = fixture.base.appendingPathComponent("workspace", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let file = root.appendingPathComponent("State.swift")
        try "let value = 1\n".write(to: file, atomically: false, encoding: .utf8)
        let store = RuntimeStore(baseDirectory: fixture.base.appendingPathComponent("runtime"))
        try await store.setAllowedRoot(root)
        let runtime = WorkspaceStateRuntime(runtimeStore: store, startsFSEvents: false)
        let initial = try await runtime.snapshot()

        try "let value = 2\n".write(to: file, atomically: false, encoding: .utf8)
        await runtime.ingestObservedPaths([file.path])
        let first = try await runtime.searchContextObservation(path: root.path, fromCursor: initial.cursor)
        let second = try await runtime.searchContextObservation(path: root.path, fromCursor: initial.cursor)

        XCTAssertEqual(first.observationViewID, second.observationViewID)
        XCTAssertEqual(first.changedPaths, ["State.swift"])
        XCTAssertEqual(first.indexedFiles, second.indexedFiles)
        XCTAssertNotEqual(
            first.indexedFiles?.first(where: { $0.path == "State.swift" })?.contentSHA256,
            initial.entries.first(where: { $0.path == "State.swift" })?.sha256
        )
        let delta = try await runtime.snapshot(sinceCursor: initial.cursor)
        XCTAssertTrue(delta.changes.contains { $0.path == "State.swift" && $0.kind == .modified })
    }

    func testWarmRestartReusesCheckpointWithoutRereadingUnchangedContent() async throws {
        let fixture = try TemporaryFixture()
        defer { fixture.cleanup() }
        let root = fixture.base.appendingPathComponent("workspace", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let file = root.appendingPathComponent("State.swift")
        try "let value = 1\n".write(to: file, atomically: false, encoding: .utf8)
        let store = RuntimeStore(baseDirectory: fixture.base.appendingPathComponent("runtime"))
        try await store.setAllowedRoot(root)
        let firstRuntime = WorkspaceStateRuntime(runtimeStore: store)
        let first = try await firstRuntime.snapshot()
        let firstReadCount = await firstRuntime.contentReadCountForTests()
        XCTAssertEqual(firstReadCount, 1)

        let secondRuntime = WorkspaceStateRuntime(runtimeStore: store)
        let restored = try await secondRuntime.snapshot()

        let secondReadCount = await secondRuntime.contentReadCountForTests()
        XCTAssertEqual(secondReadCount, 0)
        XCTAssertEqual(restored.entries.first { $0.path == "State.swift" }?.sha256,
                       first.entries.first { $0.path == "State.swift" }?.sha256)
        XCTAssertEqual(restored.cursor.split(separator: ":")[3], first.cursor.split(separator: ":")[3])
    }

    func testWarmRestartRereadsOfflineMetadataChange() async throws {
        let fixture = try TemporaryFixture()
        defer { fixture.cleanup() }
        let root = fixture.base.appendingPathComponent("workspace", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let file = root.appendingPathComponent("State.swift")
        try "let value = 1\n".write(to: file, atomically: false, encoding: .utf8)
        let store = RuntimeStore(baseDirectory: fixture.base.appendingPathComponent("runtime"))
        try await store.setAllowedRoot(root)
        let initial = try await WorkspaceStateRuntime(runtimeStore: store).snapshot()
        try "let value = 200\n".write(to: file, atomically: false, encoding: .utf8)

        let restoredRuntime = WorkspaceStateRuntime(runtimeStore: store)
        let restored = try await restoredRuntime.snapshot(sinceCursor: initial.cursor)

        let restoredReadCount = await restoredRuntime.contentReadCountForTests()
        XCTAssertEqual(restoredReadCount, 1)
        XCTAssertTrue(restored.changes.contains { $0.path == "State.swift" && $0.kind == .modified })
        XCTAssertTrue(restored.context.contains { $0.path == "State.swift" && $0.text.contains("value = 200") })
    }

    func testWarmRestartReplaysSameSizeAndRestoredMTimeChange() async throws {
        let fixture = try TemporaryFixture()
        defer { fixture.cleanup() }
        let root = fixture.base.appendingPathComponent("workspace", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let file = root.appendingPathComponent("State.txt")
        try "before\n".write(to: file, atomically: false, encoding: .utf8)
        let originalDate = try XCTUnwrap(
            file.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate
        )
        let store = RuntimeStore(baseDirectory: fixture.base.appendingPathComponent("runtime"))
        try await store.setAllowedRoot(root)
        let initial = try await WorkspaceStateRuntime(runtimeStore: store).snapshot()

        let handle = try FileHandle(forWritingTo: file)
        try handle.seek(toOffset: 0)
        try handle.write(contentsOf: Data("after!\n".utf8))
        try handle.truncate(atOffset: 7)
        try handle.close()
        try FileManager.default.setAttributes([.modificationDate: originalDate], ofItemAtPath: file.path)
        let restoredDate = try XCTUnwrap(
            file.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate
        )
        XCTAssertEqual(restoredDate, originalDate)

        let restoredRuntime = WorkspaceStateRuntime(runtimeStore: store)
        let delta = try await restoredRuntime.snapshot(sinceCursor: initial.cursor)

        XCTAssertTrue(delta.changes.contains { $0.path == "State.txt" && $0.kind == .modified })
        XCTAssertTrue(delta.context.contains { $0.path == "State.txt" && $0.text == "after!\n" })
        let readCount = await restoredRuntime.contentReadCountForTests()
        XCTAssertGreaterThanOrEqual(readCount, 1)
        XCTAssertLessThanOrEqual(readCount, 2)
    }

    func testWarmRestartContinuesCheckpointCursorAndExpiresOlderSequence() async throws {
        let fixture = try TemporaryFixture()
        defer { fixture.cleanup() }
        let root = fixture.base.appendingPathComponent("workspace", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let file = root.appendingPathComponent("State.swift")
        try "let value = 1\n".write(to: file, atomically: false, encoding: .utf8)
        let store = RuntimeStore(baseDirectory: fixture.base.appendingPathComponent("runtime"))
        try await store.setAllowedRoot(root)
        let firstRuntime = WorkspaceStateRuntime(runtimeStore: store)
        let initial = try await firstRuntime.snapshot()
        try "let value = 2\n".write(to: file, atomically: false, encoding: .utf8)
        let checkpointCursor = try await firstRuntime.snapshot(sinceCursor: initial.cursor).cursor

        let restoredRuntime = WorkspaceStateRuntime(runtimeStore: store)
        let continued = try await restoredRuntime.snapshot(sinceCursor: checkpointCursor)
        XCTAssertEqual(continued.cursor, checkpointCursor)
        XCTAssertTrue(continued.changes.isEmpty)
        do {
            _ = try await restoredRuntime.snapshot(sinceCursor: initial.cursor)
            XCTFail("checkpoint圧縮点より古いcursorへ履歴を捏造しました。")
        } catch {
            guard case AIShellError.cursorExpired = error else {
                return XCTFail("想定外のエラー: \(error)")
            }
        }
    }

    func testCorruptPersistentCheckpointFailsClosed() async throws {
        let fixture = try TemporaryFixture()
        defer { fixture.cleanup() }
        let root = fixture.base.appendingPathComponent("workspace", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        try "value\n".write(
            to: root.appendingPathComponent("State.swift"), atomically: false, encoding: .utf8
        )
        let runtimeDirectory = fixture.base.appendingPathComponent("runtime")
        let store = RuntimeStore(baseDirectory: runtimeDirectory)
        try await store.setAllowedRoot(root)
        let first = try await WorkspaceStateRuntime(runtimeStore: store, startsFSEvents: false).snapshot()
        let rootDigest = String(first.cursor.split(separator: ":")[1])
        let checkpoint = runtimeDirectory
            .appendingPathComponent("workspaces/\(rootDigest)/checkpoint.json")
        try Data("{broken".utf8).write(to: checkpoint)

        do {
            _ = try await WorkspaceStateRuntime(runtimeStore: store, startsFSEvents: false).snapshot()
            XCTFail("corrupt checkpointを黙ってfull scanしました。")
        } catch {
            guard case AIShellError.checkpointCorrupt = error else {
                return XCTFail("想定外のエラー: \(error)")
            }
        }
        XCTAssertEqual(try Data(contentsOf: checkpoint), Data("{broken".utf8))
    }

    func testCheckpointWithoutEventWatermarkCannotWarmRestore() async throws {
        let fixture = try TemporaryFixture()
        defer { fixture.cleanup() }
        let root = fixture.base.appendingPathComponent("workspace", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        try "value\n".write(
            to: root.appendingPathComponent("State.txt"), atomically: false, encoding: .utf8
        )
        let store = RuntimeStore(baseDirectory: fixture.base.appendingPathComponent("runtime"))
        try await store.setAllowedRoot(root)
        let unobserved = try await WorkspaceStateRuntime(
            runtimeStore: store, startsFSEvents: false
        ).snapshot()

        do {
            _ = try await WorkspaceStateRuntime(runtimeStore: store).snapshot(sinceCursor: unobserved.cursor)
            XCTFail("null watermark checkpointをwarm restoreしました。")
        } catch {
            guard case AIShellError.rescanRequired = error else {
                return XCTFail("想定外のエラー: \(error)")
            }
        }
    }

    func testChangedFSEventsVolumeUUIDRejectsDeltaAndRebuildsExplicitFull() async throws {
        let fixture = try TemporaryFixture()
        defer { fixture.cleanup() }
        let root = fixture.base.appendingPathComponent("workspace", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        try "value\n".write(
            to: root.appendingPathComponent("State.txt"), atomically: false, encoding: .utf8
        )
        let store = RuntimeStore(baseDirectory: fixture.base.appendingPathComponent("runtime"))
        try await store.setAllowedRoot(root)
        let firstRuntime = WorkspaceStateRuntime(
            runtimeStore: store,
            initializationEventsForTests: [],
            eventStoreUUIDProviderForTests: { _ in "11111111-1111-1111-1111-111111111111" }
        )
        let first = try await firstRuntime.snapshot()
        let changedVolumeRuntime = WorkspaceStateRuntime(
            runtimeStore: store,
            initializationEventsForTests: [],
            eventStoreUUIDProviderForTests: { _ in "22222222-2222-2222-2222-222222222222" }
        )

        do {
            _ = try await changedVolumeRuntime.snapshot(sinceCursor: first.cursor)
            XCTFail("異なるFSEvents volume UUIDでdeltaを継続しました。")
        } catch {
            guard case AIShellError.rescanRequired = error else {
                return XCTFail("想定外のエラー: \(error)")
            }
        }
        let rebuilt = try await changedVolumeRuntime.snapshot()
        XCTAssertEqual(rebuilt.checkpointState, "rebuilt")

        let continued = try await WorkspaceStateRuntime(
            runtimeStore: store,
            initializationEventsForTests: [],
            eventStoreUUIDProviderForTests: { _ in "22222222-2222-2222-2222-222222222222" }
        ).snapshot(sinceCursor: rebuilt.cursor)
        XCTAssertFalse(continued.isFull)
    }

    func testCursorBindsRootIdentityAndExclusionContract() async throws {
        let fixture = try TemporaryFixture()
        defer { fixture.cleanup() }
        let firstRoot = fixture.base.appendingPathComponent("first", isDirectory: true)
        let secondRoot = fixture.base.appendingPathComponent("second", isDirectory: true)
        try FileManager.default.createDirectory(at: firstRoot, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: secondRoot, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(
            at: firstRoot.appendingPathComponent(".build"), withIntermediateDirectories: true
        )
        let store = RuntimeStore(baseDirectory: fixture.base.appendingPathComponent("runtime"))
        try await store.setAllowedRoots([firstRoot, secondRoot])
        let runtime = WorkspaceStateRuntime(runtimeStore: store, startsFSEvents: false)

        let initial = try await runtime.snapshot(path: firstRoot.path)
        XCTAssertTrue(initial.cursor.hasPrefix("ws2:"))
        XCTAssertFalse(initial.entries.contains { $0.path.hasPrefix(".build") })
        let excluded = firstRoot.appendingPathComponent(".build/cache.bin")
        try Data("ignored".utf8).write(to: excluded)
        await runtime.ingestObservedPaths([excluded.path])
        let unchanged = try await runtime.snapshot(
            path: firstRoot.path, sinceCursor: initial.cursor
        )
        XCTAssertEqual(unchanged.cursor, initial.cursor)
        XCTAssertTrue(unchanged.changes.isEmpty)

        do {
            _ = try await runtime.snapshot(path: secondRoot.path, sinceCursor: initial.cursor)
            XCTFail("別rootへcursorを再利用できました。")
        } catch {
            guard case AIShellError.cursorExpired = error else {
                return XCTFail("想定外のエラー: \(error)")
            }
        }
    }

    func testRootReplacementRequiresExplicitRescan() async throws {
        let fixture = try TemporaryFixture()
        defer { fixture.cleanup() }
        let root = fixture.base.appendingPathComponent("workspace", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let store = RuntimeStore(baseDirectory: fixture.base.appendingPathComponent("runtime"))
        try await store.setAllowedRoot(root)
        let runtime = WorkspaceStateRuntime(runtimeStore: store, startsFSEvents: false)
        let initial = try await runtime.snapshot()

        try FileManager.default.removeItem(at: root)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        do {
            _ = try await runtime.snapshot(sinceCursor: initial.cursor)
            XCTFail("root置換後に旧cursorを継続できました。")
        } catch {
            guard case AIShellError.rescanRequired = error else {
                return XCTFail("想定外のエラー: \(error)")
            }
        }

        let recovered = try await runtime.snapshot()
        XCTAssertTrue(recovered.isFull)
        XCTAssertNotEqual(recovered.cursor, initial.cursor)
    }

    func testRootReplacementAcrossRestartRequiresExplicitRescan() async throws {
        let fixture = try TemporaryFixture()
        defer { fixture.cleanup() }
        let root = fixture.base.appendingPathComponent("workspace", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let store = RuntimeStore(baseDirectory: fixture.base.appendingPathComponent("runtime"))
        try await store.setAllowedRoot(root)
        let initial = try await WorkspaceStateRuntime(
            runtimeStore: store, startsFSEvents: false
        ).snapshot()
        try FileManager.default.removeItem(at: root)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)

        do {
            _ = try await WorkspaceStateRuntime(
                runtimeStore: store, startsFSEvents: false
            ).snapshot(sinceCursor: initial.cursor)
            XCTFail("再起動を跨ぐroot置換で旧cursorを継続できました。")
        } catch {
            guard case AIShellError.rescanRequired = error else {
                return XCTFail("想定外のエラー: \(error)")
            }
        }
    }

    func testJournalRetentionExpiresOldCursorWithoutFullScanFallback() async throws {
        let fixture = try TemporaryFixture()
        defer { fixture.cleanup() }
        let root = fixture.base.appendingPathComponent("workspace", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let store = RuntimeStore(baseDirectory: fixture.base.appendingPathComponent("runtime"))
        try await store.setAllowedRoot(root)
        let runtime = WorkspaceStateRuntime(
            runtimeStore: store, startsFSEvents: false, journalLimit: 2
        )
        let initial = try await runtime.snapshot()
        for name in ["A.txt", "B.txt", "C.txt"] {
            let file = root.appendingPathComponent(name)
            try name.write(to: file, atomically: true, encoding: .utf8)
            await runtime.ingestObservedPaths([file.path])
        }

        do {
            _ = try await runtime.snapshot(sinceCursor: initial.cursor)
            XCTFail("retention外cursorを黙って継続できました。")
        } catch {
            guard case AIShellError.cursorExpired = error else {
                return XCTFail("想定外のエラー: \(error)")
            }
        }
        let scanCount = await runtime.scanInvocationCountForTests()
        XCTAssertEqual(scanCount, 1)
    }

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
        XCTAssertEqual(delta.changes.map(\.kind), [.deleted, .created])
        XCTAssertEqual(delta.changes.map(\.path), ["Sources/App.swift", "Sources/App.swift"])
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
        XCTAssertNotEqual(recovered.cursor, initial.cursor)
        do {
            _ = try await runtime.snapshot(sinceCursor: initial.cursor)
            XCTFail("gap回復後に旧generation cursorが復活しました。")
        } catch {
            guard case AIShellError.cursorExpired = error else {
                return XCTFail("想定外のエラー: \(error)")
            }
        }
    }

    func testFullRebuildAfterGapPersistsRestartableWatermark() async throws {
        let fixture = try TemporaryFixture()
        defer { fixture.cleanup() }
        let root = fixture.base.appendingPathComponent("workspace", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        try "value\n".write(
            to: root.appendingPathComponent("State.txt"), atomically: false, encoding: .utf8
        )
        let store = RuntimeStore(baseDirectory: fixture.base.appendingPathComponent("runtime"))
        try await store.setAllowedRoot(root)
        let runtime = WorkspaceStateRuntime(runtimeStore: store)
        let initial = try await runtime.snapshot()
        await runtime.markRescanRequired(reason: "injected gap")
        do {
            _ = try await runtime.snapshot(sinceCursor: initial.cursor)
            XCTFail("gap cursorを継続しました。")
        } catch {
            guard case AIShellError.rescanRequired = error else {
                return XCTFail("想定外のエラー: \(error)")
            }
        }

        let rebuilt = try await runtime.snapshot()
        let restarted = WorkspaceStateRuntime(runtimeStore: store)
        let continued = try await restarted.snapshot(sinceCursor: rebuilt.cursor)

        XCTAssertFalse(continued.isFull)
        XCTAssertTrue(continued.changes.isEmpty)
    }

    func testHistoricalDropDuringRestartForcesExplicitFullRebuild() async throws {
        let fixture = try TemporaryFixture()
        defer { fixture.cleanup() }
        let root = fixture.base.appendingPathComponent("workspace", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let file = root.appendingPathComponent("State.txt")
        try "before\n".write(to: file, atomically: false, encoding: .utf8)
        let originalDate = try XCTUnwrap(
            file.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate
        )
        let store = RuntimeStore(baseDirectory: fixture.base.appendingPathComponent("runtime"))
        try await store.setAllowedRoot(root)
        _ = try await WorkspaceStateRuntime(runtimeStore: store).snapshot()

        let handle = try FileHandle(forWritingTo: file)
        try handle.seek(toOffset: 0)
        try handle.write(contentsOf: Data("after!\n".utf8))
        try handle.truncate(atOffset: 7)
        try handle.close()
        try FileManager.default.setAttributes([.modificationDate: originalDate], ofItemAtPath: file.path)

        let restarted = WorkspaceStateRuntime(
            runtimeStore: store,
            initializationEventsForTests: [
                ObservedFileEvent(
                    path: "/",
                    eventID: 44,
                    flags: FSEventStreamEventFlags(kFSEventStreamEventFlagUserDropped)
                ),
            ]
        )
        let rebuilt = try await restarted.snapshot(contextBudget: 1_024)
        let contentReads = await restarted.contentReadCountForTests()

        XCTAssertEqual(rebuilt.checkpointState, "rebuilt")
        XCTAssertTrue(rebuilt.context.contains { $0.path == "State.txt" && $0.text == "after!\n" })
        XCTAssertEqual(contentReads, 1)
    }

    func testFullRebuildDoesNotReusePrefetchAcrossFinalDrain() async throws {
        let fixture = try TemporaryFixture()
        defer { fixture.cleanup() }
        let root = fixture.base.appendingPathComponent("workspace", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let file = root.appendingPathComponent("State.txt")
        try "before\n".write(to: file, atomically: false, encoding: .utf8)
        let originalDate = try XCTUnwrap(
            file.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate
        )
        let store = RuntimeStore(baseDirectory: fixture.base.appendingPathComponent("runtime"))
        try await store.setAllowedRoot(root)
        _ = try await WorkspaceStateRuntime(runtimeStore: store).snapshot()

        try "middle\n".write(to: file, atomically: false, encoding: .utf8)
        try FileManager.default.setAttributes([.modificationDate: originalDate], ofItemAtPath: file.path)
        let restarted = WorkspaceStateRuntime(
            runtimeStore: store,
            initializationEventsForTests: [
                ObservedFileEvent(path: file.path, eventID: 45, flags: 0),
                ObservedFileEvent(
                    path: "/",
                    eventID: 46,
                    flags: FSEventStreamEventFlags(kFSEventStreamEventFlagUserDropped)
                ),
            ],
            rebuildHookForTests: {
                try "after!\n".write(to: file, atomically: false, encoding: .utf8)
                try FileManager.default.setAttributes(
                    [.modificationDate: originalDate], ofItemAtPath: file.path
                )
                return [ObservedFileEvent(path: file.path, eventID: 47, flags: 0)]
            }
        )
        let rebuilt = try await restarted.snapshot(contextBudget: 1_024)

        XCTAssertEqual(rebuilt.checkpointState, "rebuilt")
        XCTAssertTrue(rebuilt.context.contains { $0.path == "State.txt" && $0.text == "after!\n" })
    }

    func testUnsafeRootEventIsNotHiddenByPathExclusion() async throws {
        let fixture = try TemporaryFixture()
        defer { fixture.cleanup() }
        let root = fixture.base.appendingPathComponent("workspace", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let store = RuntimeStore(baseDirectory: fixture.base.appendingPathComponent("runtime"))
        try await store.setAllowedRoot(root)
        let runtime = WorkspaceStateRuntime(runtimeStore: store, startsFSEvents: false)
        let initial = try await runtime.snapshot()

        await runtime.ingestObservedEventsForTests([
            ObservedFileEvent(
                path: root.path,
                eventID: 42,
                flags: FSEventStreamEventFlags(kFSEventStreamEventFlagRootChanged)
            )
        ])
        do {
            _ = try await runtime.snapshot(sinceCursor: initial.cursor)
            XCTFail("root path eventのunsafe flagを除外しました。")
        } catch {
            guard case AIShellError.rescanRequired = error else {
                return XCTFail("想定外のエラー: \(error)")
            }
        }
    }

    func testDroppedEventWithSlashPathIsNotFilteredBeforeSafetyCheck() async throws {
        let fixture = try TemporaryFixture()
        defer { fixture.cleanup() }
        let root = fixture.base.appendingPathComponent("workspace", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let store = RuntimeStore(baseDirectory: fixture.base.appendingPathComponent("runtime"))
        try await store.setAllowedRoot(root)
        let runtime = WorkspaceStateRuntime(runtimeStore: store, startsFSEvents: false)
        let initial = try await runtime.snapshot()

        await runtime.ingestObservedEventsForTests([
            ObservedFileEvent(
                path: "/",
                eventID: 43,
                flags: FSEventStreamEventFlags(kFSEventStreamEventFlagUserDropped)
            ),
        ])
        do {
            _ = try await runtime.snapshot(sinceCursor: initial.cursor)
            XCTFail("root外pathで通知されたdrop flagを捨てました。")
        } catch {
            guard case AIShellError.rescanRequired = error else {
                return XCTFail("想定外のエラー: \(error)")
            }
        }
    }

    func testSamePathIdentityReplacementIsDeleteAndCreate() async throws {
        let fixture = try TemporaryFixture()
        defer { fixture.cleanup() }
        let root = fixture.base.appendingPathComponent("workspace", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let file = root.appendingPathComponent("State.txt")
        try "before\n".write(to: file, atomically: false, encoding: .utf8)
        let store = RuntimeStore(baseDirectory: fixture.base.appendingPathComponent("runtime"))
        try await store.setAllowedRoot(root)
        let runtime = WorkspaceStateRuntime(runtimeStore: store, startsFSEvents: false)
        let initial = try await runtime.snapshot()

        try FileManager.default.removeItem(at: file)
        try "after\n".write(to: file, atomically: false, encoding: .utf8)
        await runtime.ingestObservedPaths([file.path])
        let delta = try await runtime.snapshot(sinceCursor: initial.cursor)

        XCTAssertEqual(delta.changes.map(\.kind), [.deleted, .created])
        XCTAssertEqual(delta.changes.map(\.path), ["State.txt", "State.txt"])
    }

    func testSameIdentityContentChangeRemainsModified() async throws {
        let fixture = try TemporaryFixture()
        defer { fixture.cleanup() }
        let root = fixture.base.appendingPathComponent("workspace", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let file = root.appendingPathComponent("State.txt")
        try "before\n".write(to: file, atomically: false, encoding: .utf8)
        let store = RuntimeStore(baseDirectory: fixture.base.appendingPathComponent("runtime"))
        try await store.setAllowedRoot(root)
        let runtime = WorkspaceStateRuntime(runtimeStore: store, startsFSEvents: false)
        let initial = try await runtime.snapshot()

        let handle = try FileHandle(forWritingTo: file)
        try handle.truncate(atOffset: 0)
        try handle.write(contentsOf: Data("after\n".utf8))
        try handle.close()
        await runtime.ingestObservedPaths([file.path])
        let delta = try await runtime.snapshot(sinceCursor: initial.cursor)

        XCTAssertEqual(delta.changes.map(\.kind), [.modified])
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

        XCTAssertTrue(delta.changes.contains { $0.path == "State.txt" && $0.kind == .created })
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
        await runtime.ingestObservedPaths([newDirectory.path])
        let delta = try await runtime.snapshot(sinceCursor: initial.cursor, entryLimit: 1)

        XCTAssertTrue(delta.changes.contains {
            $0.kind == .renamed && $0.path == "Moved/Child.swift" && $0.previousPath == "Dir/Child.swift"
        })
    }

    func testRenamePairsStableIdentityWhenOnlyNewPathIsObserved() async throws {
        let fixture = try TemporaryFixture()
        defer { fixture.cleanup() }
        let root = fixture.base.appendingPathComponent("workspace", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let oldFile = root.appendingPathComponent("Old.swift")
        let newFile = root.appendingPathComponent("New.swift")
        try "value\n".write(to: oldFile, atomically: false, encoding: .utf8)
        let store = RuntimeStore(baseDirectory: fixture.base.appendingPathComponent("runtime"))
        try await store.setAllowedRoot(root)
        let runtime = WorkspaceStateRuntime(runtimeStore: store, startsFSEvents: false)
        let initial = try await runtime.snapshot()

        try FileManager.default.moveItem(at: oldFile, to: newFile)
        await runtime.ingestObservedPaths([newFile.path])
        let delta = try await runtime.snapshot(sinceCursor: initial.cursor)

        XCTAssertTrue(delta.changes.contains {
            $0.kind == .renamed && $0.path == "New.swift" && $0.previousPath == "Old.swift"
        })
    }

    func testCursorRejectsEachMalformedOrMismatchedField() async throws {
        let fixture = try TemporaryFixture()
        defer { fixture.cleanup() }
        let root = fixture.base.appendingPathComponent("workspace", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let store = RuntimeStore(baseDirectory: fixture.base.appendingPathComponent("runtime"))
        try await store.setAllowedRoot(root)
        let runtime = WorkspaceStateRuntime(runtimeStore: store, startsFSEvents: false)
        let initial = try await runtime.snapshot()
        let parts = initial.cursor.split(separator: ":", omittingEmptySubsequences: false).map(String.init)
        XCTAssertEqual(parts.count, 5)
        let invalid = [
            "ws1:" + parts.dropFirst().joined(separator: ":"),
            [parts[0], "different-root", parts[2], parts[3], parts[4]].joined(separator: ":"),
            [parts[0], parts[1], "different-exclusion", parts[3], parts[4]].joined(separator: ":"),
            [parts[0], parts[1], parts[2], "different-generation", parts[4]].joined(separator: ":"),
            [parts[0], parts[1], parts[2], parts[3], "1"].joined(separator: ":"),
            [parts[0], parts[1], parts[2], parts[3], "not-a-sequence"].joined(separator: ":"),
        ]
        for cursor in invalid {
            do {
                _ = try await runtime.snapshot(sinceCursor: cursor)
                XCTFail("不正cursorを受理しました: \(cursor)")
            } catch {
                guard case AIShellError.cursorExpired = error else {
                    return XCTFail("想定外のエラー: \(error)")
                }
            }
        }
    }
}
