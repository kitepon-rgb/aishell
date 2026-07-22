import CryptoKit
import XCTest
@testable import AIShellCore

final class CheckFreshnessCacheTests: XCTestCase {
    func testOffDoesNotObserveCorruptEntry() async throws {
        let clock = TestClock()
        let cache = CheckFreshnessCache.inMemory(now: { clock.now })
        let cached = request(.refresh, ["check"])
        _ = try await cache.execute(cached, executeUncached: factory("seed"))
        try await cache.markEntryCorrupt(for: cached, stepID: "check")
        let off = request(.off, ["check"])
        let outcome = try await cache.execute(off, executeUncached: factory("off"))
        XCTAssertEqual(outcome.state, .disabled)
        XCTAssertEqual(outcome.results.map(\.sourceRunID), ["off-check"])
    }

    func testPreferAndOnlyAreAggregateHitOrMissAndPreservePlan() async throws {
        let cache = CheckFreshnessCache.inMemory()
        _ = try await cache.execute(request(.refresh, ["first"]), executeUncached: factory("seed"))
        let all = request(.prefer, ["first", "second"])
        let prefer = try await cache.execute(all, executeUncached: factory("prefer"))
        XCTAssertEqual(prefer.state, .missExecuted)
        XCTAssertEqual(prefer.plan, all.plan)
        XCTAssertEqual(prefer.results.map(\.stepID), ["first", "second"])
        do {
            _ = try await cache.execute(request(.only, ["first", "third"]), executeUncached: { _ in XCTFail(); return [] })
            XCTFail()
        } catch let error as CheckFreshnessCache.Error { XCTAssertEqual(error, .cacheMiss) }
    }

    func testDifferentInvocationIdentityReusesSameFreshnessBinding() async throws {
        let cache = CheckFreshnessCache.inMemory()
        _ = try await cache.execute(request(.refresh, ["check"], invocation: "request-one"), executeUncached: factory("seed"))
        let hit = try await cache.execute(request(.only, ["check"], invocation: "request-two"), executeUncached: { _ in [] })
        XCTAssertEqual(hit.state, .hit)
        XCTAssertEqual(hit.results.map(\.sourceRunID), ["seed-check"])
    }

    func testBindingMutationIsMissAndExecutionTimeMutationPreventsPublication() async throws {
        let cache = CheckFreshnessCache.inMemory()
        _ = try await cache.execute(request(.refresh, ["check"], binding: "old"), executeUncached: factory("old"))
        let changed = request(.prefer, ["check"], binding: "new")
        let miss = try await cache.execute(changed, executeUncached: factory("new"))
        XCTAssertEqual(miss.state, .missExecuted)
        do {
            _ = try await cache.execute(request(.refresh, ["moving"]), executeUncached: factory("moving"), validateBindingAfterExecution: { _ in false })
            XCTFail()
        } catch let error as CheckFreshnessCache.Error { XCTAssertEqual(error, .contentChanged) }
        do {
            _ = try await cache.execute(request(.only, ["moving"]), executeUncached: { _ in [] })
            XCTFail()
        } catch let error as CheckFreshnessCache.Error { XCTAssertEqual(error, .cacheMiss) }
    }

    func testTTLBoundaryAndIncompleteEntryAreMissWithoutExtension() async throws {
        let clock = TestClock()
        let cache = CheckFreshnessCache.inMemory(ttl: 10, now: { clock.now })
        let refreshRequest = request(.refresh, ["check"])
        _ = try await cache.execute(refreshRequest, executeUncached: factory("seed"))
        clock.now = Date(timeIntervalSince1970: 9)
        let hit = try await cache.execute(request(.only, ["check"]), executeUncached: { _ in [] })
        XCTAssertEqual(hit.state, .hit)
        clock.now = Date(timeIntervalSince1970: 10)
        do { _ = try await cache.execute(request(.only, ["check"]), executeUncached: { _ in [] }); XCTFail() }
        catch let error as CheckFreshnessCache.Error { XCTAssertEqual(error, .cacheExpired) }
        let fresh = request(.refresh, ["fresh"])
        _ = try await cache.execute(fresh, executeUncached: factory("fresh"))
        try await cache.markEntryIncomplete(for: fresh, stepID: "fresh")
        do { _ = try await cache.execute(request(.only, ["fresh"]), executeUncached: { _ in [] }); XCTFail() }
        catch let error as CheckFreshnessCache.Error { XCTAssertEqual(error, .cacheMiss) }
    }

    func testCorruptEntryFailsClosedForWholeLookup() async throws {
        let cache = CheckFreshnessCache.inMemory()
        let refreshRequest = request(.refresh, ["first", "second"])
        _ = try await cache.execute(refreshRequest, executeUncached: factory("seed"))
        try await cache.markEntryCorrupt(for: refreshRequest, stepID: "second")
        do { _ = try await cache.execute(request(.prefer, ["first", "second"]), executeUncached: { _ in XCTFail(); return [] }); XCTFail() }
        catch let error as CheckFreshnessCache.Error { XCTAssertEqual(error, .cacheCorrupt) }
    }

    func testNonCacheableTerminalIsNotPublished() async throws {
        let cache = CheckFreshnessCache.inMemory()
        let refreshRequest = request(.refresh, ["timeout"])
        let outcome = try await cache.execute(refreshRequest, executeUncached: factory("timeout", terminal: .timedOut))
        XCTAssertEqual(outcome.publications, 0)
        do { _ = try await cache.execute(request(.only, ["timeout"]), executeUncached: { _ in [] }); XCTFail() }
        catch let error as CheckFreshnessCache.Error { XCTAssertEqual(error, .cacheMiss) }
    }

    func testNonCacheableResultDoesNotObservePublicationFailure() async throws {
        let cache = CheckFreshnessCache.inMemory(maximumEntryCount: 0)
        await cache.injectPublicationFailure(.store)
        let outcome = try await cache.execute(request(.refresh, ["timeout"]), executeUncached: factory("timeout", terminal: .timedOut))
        XCTAssertEqual(outcome.publications, 0)
        XCTAssertEqual(outcome.state, .refreshExecuted)
    }

    func testQuotaAndStoreFailureAreAtomic() async throws {
        let quota = CheckFreshnessCache.inMemory(maximumEntryCount: 1)
        do { _ = try await quota.execute(request(.refresh, ["one", "two"]), executeUncached: factory("quota")); XCTFail() }
        catch let error as CheckFreshnessCache.Error { XCTAssertEqual(error, .cacheQuotaExceeded) }
        do { _ = try await quota.execute(request(.only, ["one"]), executeUncached: { _ in [] }); XCTFail() }
        catch let error as CheckFreshnessCache.Error { XCTAssertEqual(error, .cacheMiss) }
        let store = CheckFreshnessCache.inMemory()
        await store.injectPublicationFailure(.store)
        do { _ = try await store.execute(request(.refresh, ["one", "two"]), executeUncached: factory("store")); XCTFail() }
        catch let error as CheckFreshnessCache.Error { XCTAssertEqual(error, .cacheStoreFailed) }
        await store.injectPublicationFailure(nil)
        do { _ = try await store.execute(request(.only, ["one"]), executeUncached: { _ in [] }); XCTFail() }
        catch let error as CheckFreshnessCache.Error { XCTAssertEqual(error, .cacheMiss) }
    }

    func testRefreshReusesSamePayloadWithoutTTLChangeAndRejectsConflict() async throws {
        let clock = TestClock()
        let cache = CheckFreshnessCache.inMemory(ttl: 10, now: { clock.now })
        let refresh = request(.refresh, ["check"])
        _ = try await cache.execute(refresh, executeUncached: factory("old", payload: "same"))
        clock.now = Date(timeIntervalSince1970: 9)
        let reused = try await cache.execute(refresh, executeUncached: factory("same", payload: "same"))
        XCTAssertEqual(reused.publications, 0)
        clock.now = Date(timeIntervalSince1970: 10)
        do { _ = try await cache.execute(request(.only, ["check"]), executeUncached: { _ in [] }); XCTFail() }
        catch let error as CheckFreshnessCache.Error { XCTAssertEqual(error, .cacheExpired) }
        do { _ = try await cache.execute(refresh, executeUncached: factory("new", payload: "different")); XCTFail() }
        catch let error as CheckFreshnessCache.Error { XCTAssertEqual(error, .cacheConflict) }
    }

    func testExpiredSamePayloadPublishesNewGenerationAndInvalidInputIsRejected() async throws {
        let clock = TestClock()
        let cache = CheckFreshnessCache.inMemory(ttl: 1, now: { clock.now })
        let refresh = request(.refresh, ["check"])
        _ = try await cache.execute(refresh, executeUncached: factory("old", payload: "same"))
        clock.now = Date(timeIntervalSince1970: 1)
        let renewed = try await cache.execute(refresh, executeUncached: factory("new", payload: "same"))
        XCTAssertEqual(renewed.publications, 1)
        let hit = try await cache.execute(request(.only, ["check"]), executeUncached: { _ in [] })
        XCTAssertEqual(hit.results.map(\.sourceRunID), ["new-check"])

        let invalid = CheckFreshnessCache.Request(policy: .prefer, plan: refresh.plan, orderedSteps: [.init(id: "check", bindingDigest: String(repeating: "１", count: 64))])
        do { _ = try await cache.execute(invalid, executeUncached: { _ in [] }); XCTFail() }
        catch let error as CheckFreshnessCache.Error { XCTAssertEqual(error, .invalidRequest) }
        do { _ = try await cache.execute(request(.refresh, ["empty"]), executeUncached: { steps in [result(step: steps[0], run: "", payload: "x")] }); XCTFail() }
        catch let error as CheckFreshnessCache.Error { XCTAssertEqual(error, .invalidRequest) }
    }

    func testFileBackedStoreReloadsAtomicallyAndFailsClosedOnArtifactCorruption() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("CheckFreshnessCacheTests-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: directory) }
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let artifactURL = directory.appendingPathComponent("stdout.txt")
        let artifactData = Data("verified artifact".utf8)
        try artifactData.write(to: artifactURL)
        let refreshRequest = request(.refresh, ["check"])
        let first = CheckFreshnessCache(storeDirectory: directory)
        _ = try await first.execute(refreshRequest, executeUncached: { steps in
            [fileResult(step: steps[0], artifactURL: artifactURL, artifactData: artifactData)]
        })
        let restarted = CheckFreshnessCache(storeDirectory: directory)
        let hit = try await restarted.execute(request(.only, ["check"]), executeUncached: { _ in [] })
        XCTAssertEqual(hit.state, .hit)
        try Data("corrupted".utf8).write(to: artifactURL)
        let corrupt = CheckFreshnessCache(storeDirectory: directory)
        do { _ = try await corrupt.execute(request(.only, ["check"]), executeUncached: { _ in [] }); XCTFail() }
        catch let error as CheckFreshnessCache.Error { XCTAssertEqual(error, .cacheCorrupt) }
    }

    func testFileBackedStoreFailsClosedOnUnknownSchema() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("CheckFreshnessCacheTests-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: directory) }
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let artifactURL = directory.appendingPathComponent("stdout.txt")
        let artifactData = Data("verified artifact".utf8)
        try artifactData.write(to: artifactURL)
        let refresh = request(.refresh, ["check"])
        let cache = CheckFreshnessCache(storeDirectory: directory)
        _ = try await cache.execute(refresh, executeUncached: { steps in [fileResult(step: steps[0], artifactURL: artifactURL, artifactData: artifactData)] })
        let manifestURL = directory.appendingPathComponent("freshness-cache-manifest.json")
        let manifest = try String(contentsOf: manifestURL, encoding: .utf8)
        try manifest.replacingOccurrences(of: "aishell.check-freshness-cache-manifest.v1", with: "unknown.schema").write(to: manifestURL, atomically: true, encoding: .utf8)
        let restarted = CheckFreshnessCache(storeDirectory: directory)
        do { _ = try await restarted.execute(request(.only, ["check"]), executeUncached: { _ in [] }); XCTFail() }
        catch let error as CheckFreshnessCache.Error { XCTAssertEqual(error, .cacheCorrupt) }
    }

    func testOffNeverLoadsCorruptStoreAndCorruptionRemainsFailClosedOnRetry() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("CheckFreshnessCacheTests-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: directory) }
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        try Data("not-json".utf8).write(to: directory.appendingPathComponent("freshness-cache-manifest.json"))
        let cache = CheckFreshnessCache(storeDirectory: directory)
        let off = try await cache.execute(request(.off, ["check"]), executeUncached: factory("off"))
        XCTAssertEqual(off.state, .disabled)
        for _ in 0 ..< 2 {
            do { _ = try await cache.execute(request(.only, ["check"]), executeUncached: { _ in [] }); XCTFail() }
            catch let error as CheckFreshnessCache.Error { XCTAssertEqual(error, .cacheCorrupt) }
        }
    }

    func testExpiredGenerationIsEvictedBeforeQuotaAdmission() async throws {
        let clock = TestClock()
        let cache = CheckFreshnessCache.inMemory(ttl: 1, maximumEntryCount: 1, now: { clock.now })
        _ = try await cache.execute(request(.refresh, ["old"]), executeUncached: factory("old"))
        clock.now = Date(timeIntervalSince1970: 1)
        let outcome = try await cache.execute(request(.refresh, ["new"]), executeUncached: factory("new"))
        XCTAssertEqual(outcome.publications, 1)
    }

    func testFileBackedPublicationRejectsUnboundStdoutOrStderrArtifactHash() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("CheckFreshnessCacheTests-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: directory) }
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let artifactURL = directory.appendingPathComponent("artifact.txt")
        let data = Data("real artifact".utf8)
        try data.write(to: artifactURL)
        let cache = CheckFreshnessCache(storeDirectory: directory)
        do {
            _ = try await cache.execute(request(.refresh, ["check"]), executeUncached: { steps in
                var result = fileResult(step: steps[0], artifactURL: artifactURL, artifactData: data)
                result = .init(stepID: result.stepID, terminalState: result.terminalState, sourceRunID: result.sourceRunID,
                               stdoutArtifactSHA256: digest("invented"), stderrArtifactSHA256: result.stderrArtifactSHA256,
                               payloadDigest: result.payloadDigest, artifacts: result.artifacts)
                return [result]
            })
            XCTFail()
        } catch let error as CheckFreshnessCache.Error { XCTAssertEqual(error, .cacheStoreFailed) }
    }

    func testManifestEntryExpiryTamperingFailsClosedOnEveryAttempt() async throws {
        let fixture = try FileFixture.make()
        defer { fixture.cleanup() }
        let refreshRequest = request(.refresh, ["check"])
        let cache = CheckFreshnessCache(storeDirectory: fixture.directory)
        _ = try await cache.execute(refreshRequest, executeUncached: fixture.factory("seed"))
        let manifestURL = fixture.directory.appendingPathComponent("freshness-cache-manifest.json")
        let original = try String(contentsOf: manifestURL, encoding: .utf8)
        let marker = "\"expiresAt\":"
        let start = original.range(of: marker)!.upperBound
        let end = original[start...].firstIndex(of: ",")!
        let modified = String(original[..<start]) + "0" + String(original[end...])
        try modified.write(to: manifestURL, atomically: true, encoding: .utf8)
        let restarted = CheckFreshnessCache(storeDirectory: fixture.directory)
        for _ in 0 ..< 2 {
            do { _ = try await restarted.execute(request(.only, ["check"]), executeUncached: { _ in [] }); XCTFail() }
            catch let error as CheckFreshnessCache.Error { XCTAssertEqual(error, .cacheCorrupt) }
        }
    }

    func testMissingArtifactIsPreferMissExecutedAndOnlyCacheExpired() async throws {
        let fixture = try FileFixture.make()
        defer { fixture.cleanup() }
        let cached = request(.refresh, ["check"])
        _ = try await CheckFreshnessCache(storeDirectory: fixture.directory).execute(cached, executeUncached: fixture.factory("seed"))
        try FileManager.default.removeItem(at: fixture.directory.appendingPathComponent("seed-artifact.txt"))
        let only = CheckFreshnessCache(storeDirectory: fixture.directory)
        do { _ = try await only.execute(request(.only, ["check"]), executeUncached: { _ in [] }); XCTFail() }
        catch let error as CheckFreshnessCache.Error { XCTAssertEqual(error, .cacheExpired) }
        let prefer = CheckFreshnessCache(storeDirectory: fixture.directory)
        let outcome = try await prefer.execute(request(.prefer, ["check"]), executeUncached: fixture.factory("rerun"))
        XCTAssertEqual(outcome.state, .missExecuted)
        XCTAssertEqual(outcome.publications, 1)
        let hit = try await CheckFreshnessCache(storeDirectory: fixture.directory).execute(request(.only, ["check"]), executeUncached: { _ in [] })
        XCTAssertEqual(hit.results.map(\.sourceRunID), ["file-check"])
    }

    func testFileStoreFailurePreservesOldManifestAcrossRestart() async throws {
        let fixture = try FileFixture.make()
        defer { fixture.cleanup() }
        let cache = CheckFreshnessCache(storeDirectory: fixture.directory)
        _ = try await cache.execute(request(.refresh, ["old"]), executeUncached: fixture.factory("old"))
        await cache.injectPublicationFailure(.store)
        do { _ = try await cache.execute(request(.refresh, ["new"]), executeUncached: fixture.factory("new")); XCTFail() }
        catch let error as CheckFreshnessCache.Error { XCTAssertEqual(error, .cacheStoreFailed) }
        let restarted = CheckFreshnessCache(storeDirectory: fixture.directory)
        let oldHit = try await restarted.execute(request(.only, ["old"]), executeUncached: { _ in [] })
        XCTAssertEqual(oldHit.state, .hit)
        do { _ = try await restarted.execute(request(.only, ["new"]), executeUncached: { _ in [] }); XCTFail() }
        catch let error as CheckFreshnessCache.Error { XCTAssertEqual(error, .cacheMiss) }
    }

    func testCorruptUnrelatedArtifactBlocksPublicationAndSurvivesRestart() async throws {
        let fixture = try FileFixture.make()
        defer { fixture.cleanup() }
        _ = try await CheckFreshnessCache(storeDirectory: fixture.directory).execute(request(.refresh, ["old"]), executeUncached: fixture.factory("old"))
        try Data("corrupt".utf8).write(to: fixture.directory.appendingPathComponent("old-artifact.txt"))
        let cache = CheckFreshnessCache(storeDirectory: fixture.directory)
        do { _ = try await cache.execute(request(.refresh, ["new"]), executeUncached: fixture.factory("new")); XCTFail() }
        catch let error as CheckFreshnessCache.Error { XCTAssertEqual(error, .cacheCorrupt) }
        let restarted = CheckFreshnessCache(storeDirectory: fixture.directory)
        do { _ = try await restarted.execute(request(.only, ["old"]), executeUncached: { _ in [] }); XCTFail() }
        catch let error as CheckFreshnessCache.Error { XCTAssertEqual(error, .cacheCorrupt) }
    }
}

private struct FileFixture {
    let directory: URL
    let artifactURL: URL
    static func make() throws -> FileFixture {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("CheckFreshnessCacheTests-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        return FileFixture(directory: directory, artifactURL: directory.appendingPathComponent("artifact.txt"))
    }
    func cleanup() { try? FileManager.default.removeItem(at: directory) }
    func factory(_ run: String) -> @Sendable ([CheckFreshnessCache.Step]) async throws -> [CheckFreshnessCache.Result] {
        { steps in
            let data = Data("\(run)-artifact".utf8)
            let runArtifactURL = directory.appendingPathComponent("\(run)-artifact.txt")
            try data.write(to: runArtifactURL)
            return [fileResult(step: steps[0], artifactURL: runArtifactURL, artifactData: data)]
        }
    }
}

private final class TestClock: @unchecked Sendable { var now = Date(timeIntervalSince1970: 0) }
private func request(_ policy: CheckFreshnessCache.Policy, _ ids: [String], binding: String = "binding", invocation: String = "profile_check") -> CheckFreshnessCache.Request {
    let steps = ids.map { CheckFreshnessCache.Step(id: $0, bindingDigest: digest("\(binding)-\($0)")) }
    return .init(policy: policy, plan: .init(invocationID: invocation, orderedStepIDs: ids, selectionDigest: digest(ids.joined(separator: "\u{0}"))), orderedSteps: steps)
}
private func factory(_ run: String, payload: String = "payload", terminal: CheckFreshnessCache.TerminalState = .passed) -> @Sendable ([CheckFreshnessCache.Step]) async throws -> [CheckFreshnessCache.Result] {
    { steps in steps.map { result(step: $0, run: run, payload: payload, terminal: terminal) } }
}
private func result(step: CheckFreshnessCache.Step, run: String, payload: String, terminal: CheckFreshnessCache.TerminalState = .passed) -> CheckFreshnessCache.Result {
    .init(stepID: step.id, terminalState: terminal, sourceRunID: run.isEmpty ? "" : "\(run)-\(step.id)", stdoutArtifactSHA256: digest("out-\(run)-\(step.id)"), stderrArtifactSHA256: digest("err-\(run)-\(step.id)"), payloadDigest: digest("\(payload)-\(step.id)"))
}
private func fileResult(step: CheckFreshnessCache.Step, artifactURL: URL, artifactData: Data) -> CheckFreshnessCache.Result {
    let artifactSHA = SHA256.hash(data: artifactData).map { String(format: "%02x", $0) }.joined()
    return .init(stepID: step.id, terminalState: .passed, sourceRunID: "file-\(step.id)", stdoutArtifactSHA256: artifactSHA, stderrArtifactSHA256: artifactSHA, payloadDigest: digest("file-\(step.id)"), artifacts: [.init(path: artifactURL.path, sizeBytes: artifactData.count, sha256: artifactSHA, expiresAt: .distantFuture)])
}
private func digest(_ value: String) -> String { SHA256.hash(data: Data(value.utf8)).map { String(format: "%02x", $0) }.joined() }
