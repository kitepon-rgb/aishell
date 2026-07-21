import Foundation
import XCTest
@testable import AIShellCore

final class ChangeSetQuotaLedgerTests: XCTestCase {
    func testExactEncodedMaterialsAndLedgerReachFixedPoint() async throws {
        let fixture = try Fixture()
        defer { fixture.cleanup() }
        let stageDirectory = fixture.directory.appendingPathComponent("stage", isDirectory: true)
        let trashDirectory = fixture.directory.appendingPathComponent("trash", isDirectory: true)
        try FileManager.default.createDirectory(at: stageDirectory, withIntermediateDirectories: false)
        try FileManager.default.createDirectory(at: trashDirectory, withIntermediateDirectories: false)
        let materials = ChangeSetQuotaLedger.MaterialKind.allCases.enumerated().map { index, kind in
            ChangeSetQuotaLedger.Material(
                id: "material-\(index)", idempotencyKey: "key-\(index)", kind: kind,
                encodedData: Data("\(kind.rawValue)-payload-\(index)".utf8),
                allocationDirectory: index.isMultiple(of: 2) ? stageDirectory : trashDirectory
            )
        }
        let ledger = try ChangeSetQuotaLedger(ledgerDirectory: fixture.directory, reservationID: "exact")

        let view = try await ledger.prepare(materials)

        XCTAssertEqual(view.materialBytes, materials.reduce(0) { $0 + $1.encodedData.count })
        XCTAssertGreaterThan(view.ledgerBytes, 0)
        XCTAssertEqual(view.remainingMaterialBytes, view.materialBytes)
        XCTAssertEqual(Set(materials.map(\.kind)), Set(ChangeSetQuotaLedger.MaterialKind.allCases))
        let ledgerData = try Data(contentsOf: fixture.directory.appendingPathComponent("quota-exact.json"))
        XCTAssertEqual(ledgerData.count, view.ledgerBytes)
    }

    func testDurableConsumptionIsIdempotentAndRestartConvergesPhysicalSize() async throws {
        let fixture = try Fixture()
        defer { fixture.cleanup() }
        let data = Data("complete diff bytes".utf8)
        let material = ChangeSetQuotaLedger.Material(id: "diff", idempotencyKey: "tx-1-diff", kind: .completeDiff, encodedData: data, allocationDirectory: fixture.directory)
        let first = try ChangeSetQuotaLedger(ledgerDirectory: fixture.directory, reservationID: "restart")
        let prepared = try await first.prepare([material])

        let receipt = try await first.authorizeWrite(materialID: "diff", idempotencyKey: "tx-1-diff", data: data)
        let replay = try await first.authorizeWrite(materialID: "diff", idempotencyKey: "tx-1-diff", data: data)
        XCTAssertEqual(receipt, replay)
        XCTAssertEqual(receipt.remainingBytesOnVolume, 0)
        let current = try await first.currentView()
        XCTAssertEqual(current.remainingMaterialBytes, prepared.materialBytes - data.count)

        // ledger write後・reservation truncate前のcrashを模擬する。restartはdurable remainingへ戻す。
        let reserveBeforeRestart = try XCTUnwrap(try FileManager.default.contentsOfDirectory(at: fixture.directory, includingPropertiesForKeys: nil).first { $0.lastPathComponent.contains("restart") && $0.pathExtension == "reserve" })
        let handle = try FileHandle(forWritingTo: reserveBeforeRestart)
        try handle.truncate(atOffset: UInt64(data.count))
        try handle.synchronize()
        try handle.close()

        let restarted = try ChangeSetQuotaLedger(ledgerDirectory: fixture.directory, reservationID: "restart")
        let recovered = try await restarted.reconcile()
        XCTAssertEqual(recovered.remainingMaterialBytes, 0)
        XCTAssertEqual(recovered.consumedMaterialIDs, ["diff"])
        let reserve = try XCTUnwrap(try FileManager.default.contentsOfDirectory(at: fixture.directory, includingPropertiesForKeys: nil).first { $0.lastPathComponent.contains("restart") && $0.pathExtension == "reserve" })
        XCTAssertEqual(try reserve.resourceValues(forKeys: [.fileSizeKey]).fileSize, 0)
    }

    func testWrongKeyOrDifferentBytesNeverConsumeQuota() async throws {
        let fixture = try Fixture()
        defer { fixture.cleanup() }
        let expected = Data("expected".utf8)
        let ledger = try ChangeSetQuotaLedger(ledgerDirectory: fixture.directory, reservationID: "closed")
        _ = try await ledger.prepare([.init(id: "stage", idempotencyKey: "stage-key", kind: .afterStage, encodedData: expected, allocationDirectory: fixture.directory)])

        await XCTAssertThrowsErrorAsync(try await ledger.authorizeWrite(materialID: "stage", idempotencyKey: "wrong", data: expected)) {
            XCTAssertEqual($0 as? ChangeSetQuotaLedger.LedgerError, .idempotencyMismatch("stage"))
        }
        await XCTAssertThrowsErrorAsync(try await ledger.authorizeWrite(materialID: "stage", idempotencyKey: "stage-key", data: Data("other".utf8))) {
            XCTAssertEqual($0 as? ChangeSetQuotaLedger.LedgerError, .contentMismatch("stage"))
        }
        let current = try await ledger.currentView()
        XCTAssertEqual(current.remainingMaterialBytes, expected.count)
    }

    func testDuplicateKeysAndAbsentOwningVolumeFailClosed() async throws {
        let fixture = try Fixture()
        defer { fixture.cleanup() }
        let ledger = try ChangeSetQuotaLedger(ledgerDirectory: fixture.directory, reservationID: "invalid")
        let duplicate: [ChangeSetQuotaLedger.Material] = [
            .init(id: "one", idempotencyKey: "same", kind: .evidenceData, encodedData: Data([1]), allocationDirectory: fixture.directory),
            .init(id: "two", idempotencyKey: "same", kind: .evidenceMetadata, encodedData: Data([2]), allocationDirectory: fixture.directory),
        ]
        await XCTAssertThrowsErrorAsync(try await ledger.prepare(duplicate)) {
            XCTAssertEqual($0 as? ChangeSetQuotaLedger.LedgerError, .duplicateIdempotencyKey("same"))
        }

        let missing = fixture.directory.appendingPathComponent("missing-volume")
        await XCTAssertThrowsErrorAsync(try await ledger.prepare([
            .init(id: "only", idempotencyKey: "only-key", kind: .stateSnapshot, encodedData: Data([1]), allocationDirectory: missing)
        ])) {
            XCTAssertEqual($0 as? ChangeSetQuotaLedger.LedgerError, .missingDirectory(missing.path))
        }
        XCTAssertFalse(FileManager.default.fileExists(atPath: fixture.directory.appendingPathComponent("quota-invalid.json").path))
    }

    func testCapacityAdoptionAuthorizesActualBytesAfterRestart() async throws {
        let fixture = try Fixture()
        defer { fixture.cleanup() }
        let initial = try ChangeSetQuotaLedger(ledgerDirectory: fixture.directory, reservationID: "two-stage")
        _ = try await initial.prepareCapacity([
            .init(id: "terminal", idempotencyKey: "terminal-key", kind: .terminalReplay,
                  maximumEncodedBytes: 128, allocationDirectory: fixture.directory)
        ])
        let adopted = try await initial.adoptReserve(materialID: "terminal", idempotencyKey: "terminal-key")
        XCTAssertEqual(try adopted.extentURL.resourceValues(forKeys: [.fileSizeKey]).fileSize, 128)

        let restarted = try ChangeSetQuotaLedger(ledgerDirectory: fixture.directory, reservationID: "two-stage")
        let actual = Data("terminal-after-stage-identity".utf8)
        let receipt = try await restarted.authorizeActual(materialID: "terminal", idempotencyKey: "terminal-key", data: actual)
        let replay = try await restarted.authorizeActual(materialID: "terminal", idempotencyKey: "terminal-key", data: actual)
        XCTAssertEqual(receipt, replay)
        XCTAssertEqual(receipt.bytes, actual.count)
        let attributes = try FileManager.default.attributesOfItem(atPath: adopted.extentURL.path)
        XCTAssertEqual(attributes[.size] as? Int, actual.count)
    }

    func testActualBytesOverCapacityFailClosedWithoutConsumingReserve() async throws {
        let fixture = try Fixture()
        defer { fixture.cleanup() }
        let ledger = try ChangeSetQuotaLedger(ledgerDirectory: fixture.directory, reservationID: "over-capacity")
        _ = try await ledger.prepareCapacity([
            .init(id: "journal", idempotencyKey: "journal-key", kind: .transactionJournal,
                  maximumEncodedBytes: 3, allocationDirectory: fixture.directory)
        ])
        let adopted = try await ledger.adoptReserve(materialID: "journal", idempotencyKey: "journal-key")
        await XCTAssertThrowsErrorAsync(
            try await ledger.authorizeActual(materialID: "journal", idempotencyKey: "journal-key", data: Data("four".utf8))
        ) {
            XCTAssertEqual($0 as? ChangeSetQuotaLedger.LedgerError,
                           .capacityExceeded(materialID: "journal", capacity: 3, actual: 4))
        }
        let view = try await ledger.currentView()
        XCTAssertEqual(view.remainingMaterialBytes, 3)
        XCTAssertEqual(view.consumedMaterialIDs, [])
        XCTAssertEqual(try adopted.extentURL.resourceValues(forKeys: [.fileSizeKey]).fileSize, 3)
    }

    func testRenameCrashRecoversOnlyAtPlannedFinalAndReleaseEndsVerification() async throws {
        let fixture = try Fixture()
        defer { fixture.cleanup() }
        let final = fixture.directory.appendingPathComponent("evidence-final.json")
        let wrong = fixture.directory.appendingPathComponent("redirect.json")
        let ledger = try ChangeSetQuotaLedger(ledgerDirectory: fixture.directory, reservationID: "materialize")
        _ = try await ledger.prepareCapacity([
            .init(id: "evidence", idempotencyKey: "evidence-key", kind: .evidenceData,
                  maximumEncodedBytes: 256, allocationDirectory: fixture.directory)
        ])
        let adopted = try await ledger.adoptReserve(materialID: "evidence", idempotencyKey: "evidence-key", finalURL: final)
        let actual = Data("durable evidence".utf8)
        _ = try await ledger.authorizeActual(materialID: "evidence", idempotencyKey: "evidence-key", data: actual)
        let extentHandle = try FileHandle(forWritingTo: adopted.extentURL)
        try extentHandle.write(contentsOf: actual)
        try extentHandle.synchronize()
        try extentHandle.close()
        try FileManager.default.moveItem(at: adopted.extentURL, to: final)

        // rename後・ledger更新前のcrash: planned final完全一致だけからmaterializedへ収束する。
        let restarted = try ChangeSetQuotaLedger(ledgerDirectory: fixture.directory, reservationID: "materialize")
        _ = try await restarted.reconcile()
        await XCTAssertThrowsErrorAsync(
            try await restarted.commitMaterialization(materialID: "evidence", idempotencyKey: "evidence-key", finalURL: wrong)
        ) {
            XCTAssertEqual($0 as? ChangeSetQuotaLedger.LedgerError, .finalPathMismatch("evidence"))
        }
        let first = try await restarted.commitMaterialization(materialID: "evidence", idempotencyKey: "evidence-key", finalURL: final)
        let replay = try await restarted.commitMaterialization(materialID: "evidence", idempotencyKey: "evidence-key", finalURL: final)
        XCTAssertEqual(first, replay)

        try await restarted.releaseMaterial(materialID: "evidence", idempotencyKey: "evidence-key")
        try Data("product now owns this path".utf8).write(to: final)
        _ = try await restarted.reconcile()
    }

}

private struct Fixture {
    let directory: URL
    init() throws {
        directory = FileManager.default.temporaryDirectory.appendingPathComponent("aishell-quota-ledger-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
    }
    func cleanup() { try? FileManager.default.removeItem(at: directory) }
}

private func XCTAssertThrowsErrorAsync<T>(
    _ expression: @autoclosure () async throws -> T,
    _ handler: (Error) -> Void,
    file: StaticString = #filePath,
    line: UInt = #line
) async {
    do {
        _ = try await expression()
        XCTFail("errorを返しませんでした", file: file, line: line)
    } catch {
        handler(error)
    }
}
