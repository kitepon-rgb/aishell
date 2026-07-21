import CryptoKit
import Foundation
import XCTest
@testable import AIShellCore

final class ChangeSetClientRegistryTests: XCTestCase {
    func testBootstrapPreallocatesFixedOwnerOnlyBanksAndSurvivesRestart() async throws {
        let fixture = try RegistryFixture()
        defer { fixture.cleanup() }

        let registry = try fixture.open()
        let initial = await registry.snapshot()
        XCTAssertEqual(initial.generation, 1)
        XCTAssertEqual(initial.slots.count, 64)
        XCTAssertEqual(Set(initial.slots.map(\.clientID)).count, 64)
        XCTAssertTrue(initial.slots.allSatisfy { $0.allocationState == .free && $0.currentEpoch == 0 })
        XCTAssertEqual(try fixture.permissions(of: fixture.directory), 0o700)
        XCTAssertEqual(try fixture.fileSize("registry-a.bank"), ChangeSetClientRegistry.bankByteCount)
        XCTAssertEqual(try fixture.fileSize("registry-b.bank"), ChangeSetClientRegistry.bankByteCount)
        XCTAssertEqual(try fixture.permissions(of: fixture.directory.appendingPathComponent("registry-a.bank")), 0o600)
        XCTAssertEqual(ChangeSetClientRegistry.replayCapacity, 256)
        XCTAssertEqual(ChangeSetClientRegistry.controlReceiptCapacity, 128)

        let receipt = try await registry.allocate(
            controlRequestID: fixture.uuid(1),
            proofIDDigest: fixture.digest(1),
            proofExpiresAt: fixture.clock.now().addingTimeInterval(300),
            expectedRegistryGeneration: initial.generation
        )
        XCTAssertEqual(receipt.registryGeneration, 2)
        XCTAssertEqual(receipt.slotIndex, 0)
        XCTAssertEqual(receipt.clientID, initial.slots[0].clientID)
        XCTAssertEqual(try fixture.fileSize("registry-b.bank"), ChangeSetClientRegistry.bankByteCount)

        let restarted = try fixture.open()
        let restartedSnapshot = await restarted.snapshot()
        XCTAssertEqual(restartedSnapshot.generation, 2)
        XCTAssertEqual(restartedSnapshot.slots.filter { $0.allocationState == .active }.count, 1)
        let replayedReceipt = try await restarted.allocate(
            controlRequestID: fixture.uuid(1),
            proofIDDigest: fixture.digest(1),
            proofExpiresAt: fixture.clock.now().addingTimeInterval(300),
            expectedRegistryGeneration: initial.generation
        )
        XCTAssertEqual(replayedReceipt.clientID, receipt.clientID)
        XCTAssertEqual(replayedReceipt.slotIndex, receipt.slotIndex)
        XCTAssertEqual(replayedReceipt.registryGeneration, receipt.registryGeneration)
    }

    func testHighestValidBankRecoversOneCorruptionAndBothCorruptFailClosed() async throws {
        let fixture = try RegistryFixture()
        defer { fixture.cleanup() }
        let registry = try fixture.open()
        _ = try await registry.allocate(
            controlRequestID: fixture.uuid(2),
            proofIDDigest: fixture.digest(2),
            proofExpiresAt: fixture.clock.now().addingTimeInterval(300),
            expectedRegistryGeneration: 1
        )

        try fixture.corrupt("registry-b.bank")
        let recovered = try fixture.open()
        let recoveredSnapshot = await recovered.snapshot()
        XCTAssertEqual(recoveredSnapshot.generation, 1)
        XCTAssertTrue(recoveredSnapshot.slots.allSatisfy { $0.allocationState == .free })

        try fixture.corrupt("registry-a.bank")
        XCTAssertThrowsError(try fixture.open()) { error in
            XCTAssertEqual((error as? ChangeSetClientRegistryError)?.code, .storeCorrupt)
        }
    }

    func testGenerationCASProofConsumptionAndControlReplay() async throws {
        let fixture = try RegistryFixture()
        defer { fixture.cleanup() }
        let registry = try fixture.open()
        let requestID = fixture.uuid(3)
        let proof = fixture.digest(3)
        let expiry = fixture.clock.now().addingTimeInterval(300)

        let first = try await registry.allocate(controlRequestID: requestID, proofIDDigest: proof, proofExpiresAt: expiry, expectedRegistryGeneration: 1)
        let replay = try await registry.allocate(controlRequestID: requestID, proofIDDigest: proof, proofExpiresAt: expiry, expectedRegistryGeneration: 1)
        XCTAssertEqual(replay, first)

        await XCTAssertRegistryError(.ownerProofConsumed) {
            try await registry.allocate(
                controlRequestID: fixture.uuid(4),
                proofIDDigest: proof,
                proofExpiresAt: expiry,
                expectedRegistryGeneration: first.registryGeneration
            )
        }
        await XCTAssertRegistryError(.generationChanged) {
            try await registry.allocate(
                controlRequestID: fixture.uuid(5),
                proofIDDigest: fixture.digest(5),
                proofExpiresAt: expiry,
                expectedRegistryGeneration: 1
            )
        }
    }

    func testCompactReplayLookupRetentionAndFailClosedSequenceRules() async throws {
        let fixture = try RegistryFixture()
        defer { fixture.cleanup() }
        let registry = try fixture.open()
        _ = try await registry.allocate(
            controlRequestID: fixture.uuid(6),
            proofIDDigest: fixture.digest(6),
            proofExpiresAt: fixture.clock.now().addingTimeInterval(300),
            expectedRegistryGeneration: 1
        )
        let allocatedSnapshot = await registry.snapshot()
        let client = try XCTUnwrap(allocatedSnapshot.slots.first { $0.allocationState == .active })
        let requestDigest = fixture.digest(20)

        let initialLookup = try await registry.lookup(clientID: client.clientID, epoch: client.currentEpoch, sequence: 1, requestDigest: requestDigest)
        XCTAssertEqual(initialLookup, .new(nextSequence: 1))
        let admittedGeneration = try await registry.admit(
            clientID: client.clientID,
            epoch: client.currentEpoch,
            sequence: 1,
            requestDigest: requestDigest,
            transactionID: "tx-1",
            expectedRegistryGeneration: 2
        )
        guard case let .pending(pending) = try await registry.lookup(clientID: client.clientID, epoch: client.currentEpoch, sequence: 1, requestDigest: requestDigest) else {
            return XCTFail("admitted request must be pending")
        }
        XCTAssertEqual(pending.transactionID, "tx-1")
        XCTAssertNil(pending.terminalResponseDigest)
        await XCTAssertRegistryError(.previousPending) {
            try await registry.lookup(clientID: client.clientID, epoch: client.currentEpoch, sequence: 2, requestDigest: fixture.digest(21))
        }
        await XCTAssertRegistryError(.sequenceConflict) {
            try await registry.lookup(clientID: client.clientID, epoch: client.currentEpoch, sequence: 1, requestDigest: fixture.digest(22))
        }
        await XCTAssertRegistryError(.sequenceGap) {
            try await registry.lookup(clientID: client.clientID, epoch: client.currentEpoch, sequence: 3, requestDigest: fixture.digest(23))
        }

        let terminalGeneration = try await registry.markTerminal(
            clientID: client.clientID,
            epoch: client.currentEpoch,
            sequence: 1,
            state: .committed,
            terminalResponseDigest: fixture.digest(24),
            artifact: ChangeSetReplayArtifact(handle: "artifact-1", expiresAt: fixture.clock.now().addingTimeInterval(60)),
            retentionExpiresAt: fixture.clock.now().addingTimeInterval(60),
            expectedRegistryGeneration: admittedGeneration
        )
        XCTAssertEqual(terminalGeneration, admittedGeneration + 1)
        guard case let .replay(replayed) = try await registry.lookup(clientID: client.clientID, epoch: client.currentEpoch, sequence: 1, requestDigest: requestDigest) else {
            return XCTFail("terminal request must replay")
        }
        XCTAssertEqual(replayed.terminalResponseDigest, fixture.digest(24))
        XCTAssertNil(Mirror(reflecting: replayed).children.first { $0.label == "fullResult" })

        fixture.clock.advance(61)
        await XCTAssertRegistryError(.clientExpired) {
            try await registry.lookup(clientID: client.clientID, epoch: client.currentEpoch, sequence: 1, requestDigest: requestDigest)
        }
    }

    func testEpochRotationAndRetirePreserveStableSlotIdentity() async throws {
        let fixture = try RegistryFixture()
        defer { fixture.cleanup() }
        let registry = try fixture.open()
        _ = try await registry.allocate(
            controlRequestID: fixture.uuid(7),
            proofIDDigest: fixture.digest(7),
            proofExpiresAt: fixture.clock.now().addingTimeInterval(300),
            expectedRegistryGeneration: 1
        )
        let initialSnapshot = await registry.snapshot()
        let first = try XCTUnwrap(initialSnapshot.slots.first { $0.allocationState == .active })
        let rotate = try await registry.rotateEpoch(
            controlRequestID: fixture.uuid(8),
            proofIDDigest: fixture.digest(8),
            proofExpiresAt: fixture.clock.now().addingTimeInterval(300),
            clientID: first.clientID,
            expectedEpoch: first.currentEpoch,
            nextEpoch: first.currentEpoch + 1,
            expectedRegistryGeneration: 2
        )
        await XCTAssertRegistryError(.clientExpired) {
            try await registry.lookup(clientID: first.clientID, epoch: first.currentEpoch, sequence: 1, requestDigest: fixture.digest(30))
        }
        _ = try await registry.retire(
            controlRequestID: fixture.uuid(9),
            proofIDDigest: fixture.digest(9),
            proofExpiresAt: fixture.clock.now().addingTimeInterval(300),
            clientID: first.clientID,
            expectedEpoch: first.currentEpoch + 1,
            expectedRegistryGeneration: rotate.registryGeneration
        )
        let retiredSnapshot = await registry.snapshot()
        let retired = try XCTUnwrap(retiredSnapshot.slots.first { $0.clientID == first.clientID })
        XCTAssertEqual(retired.allocationState, .free)
        XCTAssertEqual(retired.currentEpoch, first.currentEpoch + 1)

        let beforeReallocate = await registry.snapshot()
        let allocated = try await registry.allocate(
            controlRequestID: fixture.uuid(10),
            proofIDDigest: fixture.digest(10),
            proofExpiresAt: fixture.clock.now().addingTimeInterval(300),
            expectedRegistryGeneration: beforeReallocate.generation
        )
        let reusedSnapshot = await registry.snapshot()
        let reused = try XCTUnwrap(reusedSnapshot.slots.first { $0.allocationState == .active })
        XCTAssertEqual(reused.clientID, first.clientID)
        XCTAssertEqual(reused.currentEpoch, first.currentEpoch + 2)
        XCTAssertEqual(allocated.currentEpoch, reused.currentEpoch)
    }

    func testReplayReferencesAreCompactBoundedAndDeterministicallyOrdered() async throws {
        let fixture = try RegistryFixture()
        defer { fixture.cleanup() }
        let registry = try fixture.open()

        let firstReceipt = try await registry.allocate(
            controlRequestID: fixture.uuid(40),
            proofIDDigest: fixture.digest(40),
            proofExpiresAt: fixture.clock.now().addingTimeInterval(300),
            expectedRegistryGeneration: 1
        )
        let secondReceipt = try await registry.allocate(
            controlRequestID: fixture.uuid(41),
            proofIDDigest: fixture.digest(41),
            proofExpiresAt: fixture.clock.now().addingTimeInterval(300),
            expectedRegistryGeneration: firstReceipt.registryGeneration
        )
        let snapshot = await registry.snapshot()
        let first = snapshot.slots[try XCTUnwrap(firstReceipt.slotIndex)]
        let second = snapshot.slots[try XCTUnwrap(secondReceipt.slotIndex)]

        let firstGeneration = try await registry.admit(
            clientID: first.clientID,
            epoch: first.currentEpoch,
            sequence: 1,
            requestDigest: fixture.digest(42),
            transactionID: "tx-first",
            expectedRegistryGeneration: secondReceipt.registryGeneration
        )
        let secondGeneration = try await registry.admit(
            clientID: second.clientID,
            epoch: second.currentEpoch,
            sequence: 1,
            requestDigest: fixture.digest(43),
            transactionID: "tx-second",
            expectedRegistryGeneration: firstGeneration
        )
        _ = try await registry.markTerminal(
            clientID: first.clientID,
            epoch: first.currentEpoch,
            sequence: 1,
            state: .committed,
            terminalResponseDigest: fixture.digest(44),
            artifact: ChangeSetReplayArtifact(handle: "artifact-first", expiresAt: fixture.clock.now().addingTimeInterval(120)),
            retentionExpiresAt: fixture.clock.now().addingTimeInterval(120),
            expectedRegistryGeneration: secondGeneration
        )

        let references = await registry.replayReferences()
        XCTAssertEqual(references.count, 2)
        XCTAssertEqual(references.map(\.slotIndex), [0, 1])
        XCTAssertEqual(references.map(\.sequence), [1, 1])
        XCTAssertEqual(references[0].clientID, first.clientID)
        XCTAssertEqual(references[0].requestDigest, fixture.digest(42))
        XCTAssertEqual(references[0].transactionID, "tx-first")
        XCTAssertEqual(references[0].state, .committed)
        XCTAssertEqual(references[0].terminalResponseDigest, fixture.digest(44))
        XCTAssertEqual(references[0].artifactHandle, "artifact-first")
        XCTAssertNotNil(references[0].artifactExpiresAt)
        XCTAssertEqual(references[1].clientID, second.clientID)
        XCTAssertEqual(references[1].state, .pending)
        XCTAssertNil(references[1].terminalResponseDigest)
        XCTAssertNil(Mirror(reflecting: references[0]).children.first { $0.label == "fullResult" })
        XCTAssertLessThanOrEqual(references.count, ChangeSetClientRegistry.slotCount * ChangeSetClientRegistry.replayCapacity)
    }
}

private final class RegistryClock: @unchecked Sendable {
    private let lock = NSLock()
    private var value = Date(timeIntervalSince1970: 1_800_000_000)
    func now() -> Date { lock.withLock { value } }
    func advance(_ seconds: TimeInterval) { lock.withLock { value = value.addingTimeInterval(seconds) } }
}

private struct RegistryFixture {
    let directory: URL
    let key = Data(repeating: 0x5a, count: 32)
    let clock = RegistryClock()

    init() throws {
        directory = FileManager.default.temporaryDirectory.appendingPathComponent("ChangeSetClientRegistryTests-\(UUID().uuidString)", isDirectory: true)
    }

    func open() throws -> ChangeSetClientRegistry {
        try ChangeSetClientRegistry(directory: directory, rootIdentityDigest: digest(250), hmacKey: key, now: clock.now)
    }

    func cleanup() { try? FileManager.default.removeItem(at: directory) }
    func uuid(_ value: Int) -> String { String(format: "00000000-0000-4000-8000-%012d", value) }
    func digest(_ value: Int) -> String { String(repeating: String(format: "%02x", value & 0xff), count: 32) }
    func fileSize(_ name: String) throws -> Int { (try Data(contentsOf: directory.appendingPathComponent(name))).count }

    func permissions(of url: URL) throws -> Int {
        let attributes = try FileManager.default.attributesOfItem(atPath: url.path)
        return (attributes[.posixPermissions] as? NSNumber)?.intValue ?? -1
    }

    func corrupt(_ name: String) throws {
        let url = directory.appendingPathComponent(name)
        let handle = try FileHandle(forWritingTo: url)
        try handle.seek(toOffset: 140)
        try handle.write(contentsOf: Data([0xff]))
        try handle.synchronize()
        try handle.close()
    }
}

private func XCTAssertRegistryError<T>(
    _ code: ChangeSetClientRegistryError.Code,
    file: StaticString = #filePath,
    line: UInt = #line,
    _ body: () async throws -> T
) async {
    do {
        _ = try await body()
        XCTFail("expected \(code.rawValue)", file: file, line: line)
    } catch let error as ChangeSetClientRegistryError {
        XCTAssertEqual(error.code, code, file: file, line: line)
    } catch {
        XCTFail("unexpected error: \(error)", file: file, line: line)
    }
}
