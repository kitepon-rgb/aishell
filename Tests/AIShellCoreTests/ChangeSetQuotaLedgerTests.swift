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
