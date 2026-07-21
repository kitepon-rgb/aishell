import Darwin
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

    func testPhysicalReservationFailureReportsTypedMaterialDiagnostic() async throws {
        let fixture = try Fixture()
        defer { fixture.cleanup() }
        let ledger = try ChangeSetQuotaLedger(ledgerDirectory: fixture.directory, reservationID: "diagnostic")
        _ = try await ledger.prepareCapacity([
            .init(id: "terminal-slot", idempotencyKey: "terminal-diagnostic", kind: .terminalReplay,
                  maximumEncodedBytes: 32, allocationDirectory: fixture.directory)
        ])
        let extent = try XCTUnwrap(try FileManager.default.contentsOfDirectory(at: fixture.directory, includingPropertiesForKeys: nil)
            .first { $0.pathExtension == "extent" && $0.lastPathComponent.contains("terminal-slot") })
        try FileManager.default.removeItem(at: extent)

        await XCTAssertThrowsErrorAsync(
            try await ledger.adoptReserve(materialID: "terminal-slot", idempotencyKey: "terminal-diagnostic",
                                          finalURL: fixture.directory.appendingPathComponent("terminal.json"))
        ) { error in
            guard case let ChangeSetQuotaLedger.LedgerError.physicalReservationNotConverged(diagnostic) = error else {
                return XCTFail("typed physical diagnosticではありません: \(error)")
            }
            XCTAssertEqual(diagnostic.materialID, "terminal-slot")
            XCTAssertEqual(diagnostic.state, .reserved)
            XCTAssertEqual(diagnostic.failureStage, .open)
            XCTAssertFalse(diagnostic.extentExists)
            XCTAssertFalse(diagnostic.finalExists)
            XCTAssertEqual(diagnostic.expectedSizeBytes, 32)
            XCTAssertNil(diagnostic.physicalSizeBytes)
            XCTAssertGreaterThan(diagnostic.expectedDevice, 0)
        }
    }

    func testAbandonPreparedRequiresExpiredSameOwnerLeaseAndZeroReferences() async throws {
        let fixture = try Fixture()
        defer { fixture.cleanup() }
        let now = Date()
        let liveOwner = ChangeSetQuotaLedger.OwnerBinding(
            bootID: "boot-live", processStartIdentity: "process-live", instanceNonce: "instance-live",
            leaseExpiresAt: now.addingTimeInterval(60)
        )
        let liveLedger = try ChangeSetQuotaLedger(ledgerDirectory: fixture.directory, reservationID: "live-lease", ownerBinding: liveOwner)
        _ = try await liveLedger.prepareCapacity([
            .init(id: "live", idempotencyKey: "live-key", kind: .canonicalEnvelope,
                  maximumEncodedBytes: 8, allocationDirectory: fixture.directory)
        ])
        let liveAttestation = ChangeSetQuotaLedger.PreparedAbandonmentAttestation(
            digest: String(repeating: "f", count: 64), owner: liveOwner, admissionReferenced: false,
            transactionDirectoryReferenced: false, registryReferenced: false
        )
        await XCTAssertThrowsErrorAsync(try await liveLedger.abandonPrepared(attestation: liveAttestation, now: now)) {
            XCTAssertEqual($0 as? ChangeSetQuotaLedger.LedgerError, .leaseStillLive)
        }
        let owner = ChangeSetQuotaLedger.OwnerBinding(
            bootID: "boot-test", processStartIdentity: "process-test", instanceNonce: "instance-test",
            leaseExpiresAt: now.addingTimeInterval(-601)
        )
        let ledger = try ChangeSetQuotaLedger(ledgerDirectory: fixture.directory, reservationID: "abandon", ownerBinding: owner,
                                              lifecycleFailurePoint: .abandonmentIntentPersisted)
        _ = try await ledger.prepareCapacity([
            .init(id: "reservation", idempotencyKey: "reservation-key", kind: .canonicalEnvelope,
                  maximumEncodedBytes: 48, allocationDirectory: fixture.directory)
        ])
        let referenced = ChangeSetQuotaLedger.PreparedAbandonmentAttestation(
            digest: String(repeating: "a", count: 64), owner: owner, admissionReferenced: false,
            transactionDirectoryReferenced: false, registryReferenced: true
        )
        await XCTAssertThrowsErrorAsync(try await ledger.abandonPrepared(attestation: referenced, now: now)) {
            XCTAssertEqual($0 as? ChangeSetQuotaLedger.LedgerError, .abandonmentReferenced)
        }
        let foreign = ChangeSetQuotaLedger.OwnerBinding(
            bootID: "other-boot", processStartIdentity: owner.processStartIdentity,
            instanceNonce: owner.instanceNonce, leaseExpiresAt: owner.leaseExpiresAt
        )
        let foreignAttestation = ChangeSetQuotaLedger.PreparedAbandonmentAttestation(
            digest: String(repeating: "b", count: 64), owner: foreign, admissionReferenced: false,
            transactionDirectoryReferenced: false, registryReferenced: false
        )
        await XCTAssertThrowsErrorAsync(try await ledger.abandonPrepared(attestation: foreignAttestation, now: now)) {
            XCTAssertEqual($0 as? ChangeSetQuotaLedger.LedgerError, .ownerBindingMismatch)
        }
        let accepted = ChangeSetQuotaLedger.PreparedAbandonmentAttestation(
            digest: String(repeating: "c", count: 64), owner: owner, admissionReferenced: false,
            transactionDirectoryReferenced: false, registryReferenced: false
        )
        await XCTAssertThrowsErrorAsync(try await ledger.abandonPrepared(attestation: accepted, now: now)) {
            XCTAssertEqual(($0 as? ChangeSetQuotaLedger.SimulatedLifecycleCrash)?.point, .abandonmentIntentPersisted)
        }
        let restarted = try ChangeSetQuotaLedger(ledgerDirectory: fixture.directory, reservationID: "abandon", ownerBinding: owner)
        _ = try await restarted.reconcile()
        let receipt = try await restarted.abandonPrepared(attestation: accepted, now: now)
        let replay = try await restarted.abandonPrepared(attestation: accepted, now: now)
        XCTAssertEqual(receipt, replay)
        let abandonedView = try await restarted.currentView()
        XCTAssertEqual(abandonedView.materialStates["reservation"], .abandoned)
        XCTAssertFalse(try FileManager.default.contentsOfDirectory(at: fixture.directory, includingPropertiesForKeys: nil)
            .contains { $0.pathExtension == "extent" && $0.lastPathComponent.contains("abandon") })
    }

    func testRecycleReleasedRequiresRetentionAndGenerationCASAndRejectsOldKey() async throws {
        let fixture = try Fixture()
        defer { fixture.cleanup() }
        let final = fixture.directory.appendingPathComponent("recycled-final")
        let ledger = try ChangeSetQuotaLedger(ledgerDirectory: fixture.directory, reservationID: "recycle")
        _ = try await ledger.prepareCapacity([
            .init(id: "slot", idempotencyKey: "old-key", kind: .terminalReplay,
                  maximumEncodedBytes: 64, allocationDirectory: fixture.directory)
        ])
        let reserve = try await ledger.adoptReserve(materialID: "slot", idempotencyKey: "old-key", finalURL: final)
        let data = Data("old terminal".utf8)
        _ = try await ledger.authorizeActual(materialID: "slot", idempotencyKey: "old-key", data: data)
        try Self.write(data, toExtent: reserve.extentURL); try FileManager.default.moveItem(at: reserve.extentURL, to: final)
        _ = try await ledger.commitMaterialization(materialID: "slot", idempotencyKey: "old-key", finalURL: final)
        try await ledger.releaseMaterial(materialID: "slot", idempotencyKey: "old-key")

        let notExpired = ChangeSetQuotaLedger.RetentionExpiredAttestation(
            digest: String(repeating: "d", count: 64), materialID: "slot", generation: 0,
            terminalReplayRetentionExpired: false
        )
        let replacement = ChangeSetQuotaLedger.Capacity(
            id: "slot", idempotencyKey: "new-key", kind: .terminalReplay,
            maximumEncodedBytes: 96, allocationDirectory: fixture.directory
        )
        await XCTAssertThrowsErrorAsync(try await ledger.recycleReleased(
            materialID: "slot", expectedGeneration: 0, retentionExpiredAttestation: notExpired, replacement: replacement
        )) { XCTAssertEqual($0 as? ChangeSetQuotaLedger.LedgerError, .retentionNotExpired("slot")) }
        let expired = ChangeSetQuotaLedger.RetentionExpiredAttestation(
            digest: String(repeating: "e", count: 64), materialID: "slot", generation: 0,
            terminalReplayRetentionExpired: true
        )
        await XCTAssertThrowsErrorAsync(try await ledger.recycleReleased(
            materialID: "slot", expectedGeneration: 1, retentionExpiredAttestation: expired, replacement: replacement
        )) { XCTAssertEqual($0 as? ChangeSetQuotaLedger.LedgerError, .generationMismatch(expected: 1, actual: 0)) }
        let recycled = try await ledger.recycleReleased(
            materialID: "slot", expectedGeneration: 0, retentionExpiredAttestation: expired, replacement: replacement
        )
        XCTAssertEqual(recycled.state, .reserved)
        XCTAssertEqual(recycled.slotGeneration, 1)
        let restarted = try ChangeSetQuotaLedger(ledgerDirectory: fixture.directory, reservationID: "recycle")
        let restartedMaterials = try await restarted.materialViews()
        XCTAssertEqual(restartedMaterials.first?.slotGeneration, 1)
        await XCTAssertThrowsErrorAsync(try await ledger.adoptReserve(
            materialID: "slot", idempotencyKey: "old-key", finalURL: final
        )) { XCTAssertEqual($0 as? ChangeSetQuotaLedger.LedgerError, .idempotencyMismatch("slot")) }
        _ = try await ledger.adoptReserve(materialID: "slot", idempotencyKey: "new-key", finalURL: final)
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

    func testGenerationReplacementAtomicallySupersedesOldAndRecoversAfterRenameCrash() async throws {
        let fixture = try Fixture()
        defer { fixture.cleanup() }
        let final = fixture.directory.appendingPathComponent("CURRENT")
        let ledger = try ChangeSetQuotaLedger(ledgerDirectory: fixture.directory, reservationID: "generations")
        _ = try await ledger.prepareCapacity([
            .init(id: "generation-old", idempotencyKey: "old-key", kind: .stateSnapshot,
                  maximumEncodedBytes: 64, allocationDirectory: fixture.directory),
            .init(id: "generation-new", idempotencyKey: "new-key", kind: .stateSnapshot,
                  maximumEncodedBytes: 64, allocationDirectory: fixture.directory),
        ])

        let oldReserve = try await ledger.adoptReserve(materialID: "generation-old", idempotencyKey: "old-key", finalURL: final)
        let oldData = Data("old-generation".utf8)
        _ = try await ledger.authorizeActual(materialID: "generation-old", idempotencyKey: "old-key", data: oldData)
        try Self.write(oldData, toExtent: oldReserve.extentURL)
        try FileManager.default.moveItem(at: oldReserve.extentURL, to: final)
        _ = try await ledger.commitMaterialization(materialID: "generation-old", idempotencyKey: "old-key", finalURL: final)

        let newReserve = try await ledger.adoptReserve(materialID: "generation-new", idempotencyKey: "new-key", finalURL: final)
        let newData = Data("new-generation".utf8)
        _ = try await ledger.authorizeActual(materialID: "generation-new", idempotencyKey: "new-key", data: newData)
        try Self.write(newData, toExtent: newReserve.extentURL)
        let explicit = try await ledger.commitReplacement(
            oldMaterialID: "generation-old", oldIdempotencyKey: "old-key",
            newMaterialID: "generation-new", newIdempotencyKey: "new-key", finalURL: final
        )
        XCTAssertEqual(explicit.supersededMaterialID, "generation-old")
        XCTAssertEqual(try Data(contentsOf: final), newData)
        var view = try await ledger.currentView()
        XCTAssertEqual(view.materialStates["generation-old"], .released)
        XCTAssertEqual(view.materialStates["generation-new"], .materialized)
        XCTAssertEqual(view.materializedMaterialIDs, ["generation-new"])
        XCTAssertEqual(view.releasedMaterialIDs, ["generation-old"])
        let generations = try await ledger.materialViews()
        XCTAssertNotNil(generations.first { $0.id == "generation-new" }?.generation)
        await XCTAssertThrowsErrorAsync(
            try await ledger.authorizeActual(materialID: "generation-new", idempotencyKey: "new-key", data: newData)
        ) { XCTAssertEqual($0 as? ChangeSetQuotaLedger.LedgerError, .materializationIncomplete("generation-new")) }
        await XCTAssertThrowsErrorAsync(
            try await ledger.adoptReserve(materialID: "generation-old", idempotencyKey: "old-key", finalURL: final)
        ) { XCTAssertEqual($0 as? ChangeSetQuotaLedger.LedgerError, .materializationIncomplete("generation-old")) }

        // 次世代をoutside renameし、rename後・ledger persist前のcrashを模擬する。
        try await ledger.releaseMaterial(materialID: "generation-new", idempotencyKey: "new-key")
        // release済み世代を再利用せず、別ledgerでold/newの同じ境界を再現する。
        let crashLedger = try ChangeSetQuotaLedger(ledgerDirectory: fixture.directory, reservationID: "generation-crash")
        _ = try await crashLedger.prepareCapacity([
            .init(id: "old", idempotencyKey: "o", kind: .transactionJournal, maximumEncodedBytes: 64, allocationDirectory: fixture.directory),
            .init(id: "new", idempotencyKey: "n", kind: .transactionJournal, maximumEncodedBytes: 64, allocationDirectory: fixture.directory),
        ])
        let crashFinal = fixture.directory.appendingPathComponent("WAL")
        let old = try await crashLedger.adoptReserve(materialID: "old", idempotencyKey: "o", finalURL: crashFinal)
        _ = try await crashLedger.authorizeActual(materialID: "old", idempotencyKey: "o", data: oldData)
        try Self.write(oldData, toExtent: old.extentURL); try FileManager.default.moveItem(at: old.extentURL, to: crashFinal)
        _ = try await crashLedger.commitMaterialization(materialID: "old", idempotencyKey: "o", finalURL: crashFinal)
        let new = try await crashLedger.adoptReserve(materialID: "new", idempotencyKey: "n", finalURL: crashFinal)
        _ = try await crashLedger.authorizeActual(materialID: "new", idempotencyKey: "n", data: newData)
        try Self.write(newData, toExtent: new.extentURL)
        XCTAssertEqual(rename(new.extentURL.path, crashFinal.path), 0)
        let restarted = try ChangeSetQuotaLedger(ledgerDirectory: fixture.directory, reservationID: "generation-crash")
        _ = try await restarted.reconcile()
        view = try await restarted.currentView()
        XCTAssertEqual(view.materialStates["old"], .released)
        XCTAssertEqual(view.materialStates["new"], .materialized)
    }

    private static func write(_ data: Data, toExtent url: URL) throws {
        let handle = try FileHandle(forWritingTo: url)
        try handle.write(contentsOf: data); try handle.synchronize(); try handle.close()
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
