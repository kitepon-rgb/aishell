import Foundation
import XCTest
@testable import AIShellCore

final class ChangeSetTransactionStoreTests: XCTestCase {
    func testTransactionSnapshotsAreEncryptedOwnerOnlyAndRestartReadable() async throws {
        let fixture = try Fixture()
        let store = try fixture.makeStore()
        let preparing = fixture.snapshot(state: .preparing, payload: Data("secret-payload".utf8))

        try await store.persistTransition(preparing)

        let transactionDirectory = fixture.transactionDirectory
        let encrypted = try Data(contentsOf: transactionDirectory.appendingPathComponent("snapshot.enc"))
        XCTAssertFalse(String(data: encrypted, encoding: .utf8)?.contains("secret-payload") == true)
        XCTAssertEqual(try permissions(fixture.storeDirectory), 0o700)
        XCTAssertEqual(try permissions(transactionDirectory), 0o700)
        XCTAssertEqual(try permissions(transactionDirectory.appendingPathComponent("snapshot.enc")), 0o600)

        let restarted = try fixture.makeStore()
        let loaded = try await restarted.load(fixture.transactionID)
        let active = try await restarted.listActive()
        XCTAssertEqual(loaded, preparing)
        XCTAssertEqual(active, [preparing])
    }

    func testIncompleteJournalTailIsDiscardedAndNextTransitionRemainsValid() async throws {
        let fixture = try Fixture()
        let store = try fixture.makeStore()
        let preparing = fixture.snapshot(state: .preparing)
        try await store.persistTransition(preparing)
        try Data("{\"torn\":".utf8).append(to: fixture.journalURL)

        let restarted = try fixture.makeStore()
        let loadedPreparing = try await restarted.load(fixture.transactionID)
        XCTAssertEqual(loadedPreparing, preparing)
        let prepared = fixture.snapshot(state: .prepared)
        try await restarted.persistTransition(prepared, expectedState: .preparing)

        let restartedAgain = try fixture.makeStore()
        let loadedPrepared = try await restartedAgain.load(fixture.transactionID)
        XCTAssertEqual(loadedPrepared, prepared)
    }

    func testWALAheadOfPreviousSnapshotIsReconciledAfterRestart() async throws {
        let fixture = try Fixture()
        let store = try fixture.makeStore()
        try await store.persistTransition(fixture.snapshot(state: .preparing))
        let snapshotURL = fixture.transactionDirectory.appendingPathComponent("snapshot.enc")
        let previousSnapshot = try Data(contentsOf: snapshotURL)
        let prepared = fixture.snapshot(state: .prepared)
        try await store.persistTransition(prepared, expectedState: .preparing)

        // WAL fsync後・snapshot atomic replace前のcrashを、直前世代snapshotへ戻して再現する。
        try previousSnapshot.write(to: snapshotURL, options: .atomic)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: snapshotURL.path)

        let restarted = try fixture.makeStore()
        let reconciled = try await restarted.load(fixture.transactionID)
        XCTAssertEqual(reconciled, prepared)
        let restartedAgain = try fixture.makeStore()
        let durable = try await restartedAgain.load(fixture.transactionID)
        XCTAssertEqual(durable, prepared)
    }

    func testCompleteJournalCorruptionFailsClosedWithoutDeletingMaterial() async throws {
        let fixture = try Fixture()
        let store = try fixture.makeStore()
        try await store.persistTransition(fixture.snapshot(state: .preparing))
        try Data("{\"complete\":\"but-invalid\"}\n".utf8).append(to: fixture.journalURL)

        let restarted = try fixture.makeStore()
        await XCTAssertThrowsStoreError(.corrupt("journal decode failed at 1")) {
            _ = try await restarted.listActive()
        }
        XCTAssertTrue(FileManager.default.fileExists(atPath: fixture.transactionDirectory.path))
    }

    func testStaleAndBackwardTransitionsAreRejected() async throws {
        let fixture = try Fixture()
        let store = try fixture.makeStore()
        try await store.persistTransition(fixture.snapshot(state: .preparing))
        try await store.persistTransition(fixture.snapshot(state: .prepared), expectedState: .preparing)

        await XCTAssertThrowsStoreError(.staleTransition(expected: .preparing, actual: .prepared)) {
            try await store.persistTransition(fixture.snapshot(state: .commitDecided), expectedState: .preparing)
        }
        await XCTAssertThrowsStoreError(.invalidTransition(from: .prepared, to: .preparing)) {
            try await store.persistTransition(fixture.snapshot(state: .preparing), expectedState: .prepared)
        }
    }

    func testRuntimeReceiptsStayBoundedAndTerminalCleanupRemovesAllReferences() async throws {
        let fixture = try Fixture(maxRuntimeReceipts: 2, terminalRetention: 10)
        let store = try fixture.makeStore()
        for index in 0..<3 {
            let id = ApplyChangeSetTransactionID("transaction-\(index)")
            try await store.persistTransition(fixture.snapshot(id: id, state: .preparing))
            try await store.appendRuntimeReceipt(.init(
                transactionID: id,
                cursor: .init(root: fixture.root.path, generation: "g", sequence: UInt64(index + 1)),
                paths: ["file-\(index)"], digest: "digest-\(index)",
                recordedAt: Date(timeIntervalSince1970: Double(index)), terminalAt: Date(timeIntervalSince1970: Double(index))
            ))
        }
        let receiptIDs = try await store.runtimeReceipts().map(\.transactionID.rawValue)
        XCTAssertEqual(receiptIDs, ["transaction-1", "transaction-2"])

        let terminal = fixture.snapshot(id: fixture.transactionID, state: .abortedBeforeSideEffect, terminalAt: Date(timeIntervalSince1970: 100))
        try await store.persistTransition(fixture.snapshot(state: .preparing))
        try await store.persistTransition(terminal, expectedState: .preparing)
        let removed = try await store.cleanup(now: Date(timeIntervalSince1970: 111))
        XCTAssertTrue(removed.contains(fixture.transactionID))
        let cleaned = try await store.load(fixture.transactionID)
        XCTAssertNil(cleaned)
        XCTAssertFalse(FileManager.default.fileExists(atPath: fixture.transactionDirectory.path))
    }

    func testUnknownOrphanDirectoryFailsClosed() async throws {
        let fixture = try Fixture()
        let orphan = fixture.storeDirectory.appendingPathComponent("transactions/orphan", isDirectory: true)
        try FileManager.default.createDirectory(at: orphan, withIntermediateDirectories: true)
        try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: fixture.storeDirectory.path)
        try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: orphan.deletingLastPathComponent().path)
        try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: orphan.path)
        let store = try fixture.makeStore()
        await XCTAssertThrowsStoreError(.orphan("orphan")) { _ = try await store.listActive() }
        XCTAssertTrue(FileManager.default.fileExists(atPath: orphan.path))
    }
}

private struct Fixture {
    let root: URL
    let storeDirectory: URL
    let transactionID = ApplyChangeSetTransactionID("transaction-main")
    let key = Data(repeating: 0xA5, count: 32)
    let maxRuntimeReceipts: Int
    let terminalRetention: TimeInterval

    init(maxRuntimeReceipts: Int = 16, terminalRetention: TimeInterval = 60) throws {
        root = FileManager.default.temporaryDirectory.appendingPathComponent("change-set-store-tests-\(UUID().uuidString)", isDirectory: true)
        storeDirectory = root.appendingPathComponent("store", isDirectory: true)
        self.maxRuntimeReceipts = maxRuntimeReceipts
        self.terminalRetention = terminalRetention
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    }

    func makeStore() throws -> ChangeSetTransactionStore {
        try ChangeSetTransactionStore(
            directory: storeDirectory, encryptionKey: key,
            maxRuntimeReceipts: maxRuntimeReceipts, terminalRetention: terminalRetention
        )
    }

    func snapshot(
        id: ApplyChangeSetTransactionID? = nil,
        state: ApplyChangeSetTransactionState,
        payload: Data = Data("payload".utf8),
        terminalAt: Date? = nil
    ) -> ChangeSetTransactionStore.Snapshot {
        .init(
            transactionID: id ?? transactionID, state: state, manifestDigest: "manifest-digest",
            references: [.init(kind: "artifact", identifier: "artifact-1", digest: "artifact-digest")],
            payload: payload, terminalAt: terminalAt
        )
    }

    var transactionDirectory: URL {
        storeDirectory.appendingPathComponent("transactions", isDirectory: true)
            .appendingPathComponent(ChangeSetTransactionStore.directoryName(for: transactionID.rawValue), isDirectory: true)
    }

    var journalURL: URL { transactionDirectory.appendingPathComponent("journal.wal") }
}

private func permissions(_ url: URL) throws -> Int {
    let attributes = try FileManager.default.attributesOfItem(atPath: url.path)
    return (attributes[.posixPermissions] as? NSNumber)?.intValue ?? -1
}

private extension Data {
    func append(to url: URL) throws {
        let handle = try FileHandle(forWritingTo: url)
        defer { try? handle.close() }
        try handle.seekToEnd()
        try handle.write(contentsOf: self)
        try handle.synchronize()
    }
}

private func XCTAssertThrowsStoreError<T>(
    _ expected: ChangeSetTransactionStore.StoreError,
    file: StaticString = #filePath,
    line: UInt = #line,
    _ operation: () async throws -> T
) async {
    do {
        _ = try await operation()
        XCTFail("expected \(expected)", file: file, line: line)
    } catch let error as ChangeSetTransactionStore.StoreError {
        XCTAssertEqual(error, expected, file: file, line: line)
    } catch {
        XCTFail("unexpected error: \(error)", file: file, line: line)
    }
}
