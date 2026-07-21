import CryptoKit
import Foundation
import XCTest
@testable import AIShellCore

final class SearchContextServiceTests: XCTestCase {
    func testMultipleQueriesDeduplicateOneLocationAndShareBudgetAcrossPages() async throws {
        let fixture = try SearchFixture()
        defer { fixture.cleanup() }
        for index in 0..<5 {
            try ("needle " + String(repeating: "x", count: 360) + " \(index)\n").write(
                to: fixture.root.appendingPathComponent("File\(index).swift"),
                atomically: true,
                encoding: .utf8
            )
        }
        let service = try fixture.service()
        let request = SearchContextRequestV2(
            queries: [
                .init(id: "fixed", kind: .fixed, pattern: "needle"),
                .init(id: "regex", kind: .regex, pattern: "need[a-z]+")
            ],
            ranking: [],
            maxResults: 5,
            byteBudget: 1_600
        )

        var page = try await service.search(request, environment: fixture.environment())
        var matches = page.matches
        XCTAssertLessThanOrEqual(page.returnedBytes, request.byteBudget)
        XCTAssertEqual(page.hasMore, page.continuation != nil)
        XCTAssertNotNil(page.continuation)
        while let continuation = page.continuation {
            page = try await service.continueSearch(continuation)
            XCTAssertLessThanOrEqual(page.returnedBytes, request.byteBudget)
            XCTAssertEqual(page.hasMore, page.continuation != nil)
            matches.append(contentsOf: page.matches)
        }

        XCTAssertEqual(matches.count, 5, "fixedとregexが同じbyte rangeを二重計上しました。")
        XCTAssertEqual(Set(matches.map(\.canonicalIdentity)).count, 5)
        XCTAssertTrue(matches.allSatisfy { $0.queryIDs == ["fixed", "regex"] })
        XCTAssertEqual(matches.map(\.path), (0..<5).map { "File\($0).swift" })
    }

    func testContinuationIsIntegrityProtectedAndRejectsChangedReferencedFile() async throws {
        let fixture = try SearchFixture()
        defer { fixture.cleanup() }
        for index in 0..<4 {
            try ("needle " + String(repeating: "y", count: 380) + "\n").write(
                to: fixture.root.appendingPathComponent("Page\(index).swift"),
                atomically: true,
                encoding: .utf8
            )
        }
        let service = try fixture.service(tokenSecret: Data(repeating: 7, count: 32))
        let first = try await service.search(
            .init(
                queries: [.init(id: "q", kind: .fixed, pattern: "needle")],
                ranking: [], maxResults: 4, byteBudget: 1_600
            ),
            environment: fixture.environment()
        )
        let token = try XCTUnwrap(first.continuation)
        let replacement = token.last == "A" ? "B" : "A"
        let tampered = String(token.dropLast()) + replacement
        do {
            _ = try await service.continueSearch(tampered)
            XCTFail("改ざんしたcontinuationを受理しました。")
        } catch let error as SearchContextServiceError {
            XCTAssertEqual(error, .cursorExpired(reason: "integrity_mismatch"))
        }

        try "needle changed\n".write(
            to: fixture.root.appendingPathComponent("Page3.swift"),
            atomically: true,
            encoding: .utf8
        )
        do {
            _ = try await service.continueSearch(token)
            XCTFail("page間で変更されたfileを凍結snapshotとして返しました。")
        } catch let error as SearchContextServiceError {
            guard case .contentChanged = error else {
                return XCTFail("想定外のエラー: \(error)")
            }
        }
    }

    func testGlobUsesOnlyAttestedIndexAndNeverFallsBackToFilesystemScan() async throws {
        let fixture = try SearchFixture()
        defer { fixture.cleanup() }
        let source = fixture.root.appendingPathComponent("Sources/Main.swift")
        try FileManager.default.createDirectory(at: source.deletingLastPathComponent(), withIntermediateDirectories: true)
        try "let value = 1\n".write(to: source, atomically: true, encoding: .utf8)
        let indexed = try fixture.indexedFile(relativePath: "Sources/Main.swift")
        let decoy = fixture.root.appendingPathComponent("SourcesExtra/No.swift")
        try FileManager.default.createDirectory(at: decoy.deletingLastPathComponent(), withIntermediateDirectories: true)
        try "let decoy = 1\n".write(to: decoy, atomically: true, encoding: .utf8)
        let indexedDecoy = try fixture.indexedFile(relativePath: "SourcesExtra/No.swift")
        let service = try fixture.service()
        let request = SearchContextRequestV2(
            queries: [.init(id: "paths", kind: .glob, pattern: "Sources/**")],
            ranking: [], byteBudget: 4_096
        )

        do {
            _ = try await service.search(request, environment: fixture.environment(indexedFiles: nil))
            XCTFail("indexなしでfilesystem scanへfallbackしました。")
        } catch let error as SearchContextServiceError {
            guard case .rescanRequired = error else {
                return XCTFail("想定外のエラー: \(error)")
            }
        }

        let result = try await service.search(
            request,
            environment: fixture.environment(indexedFiles: [indexed, indexedDecoy])
        )
        XCTAssertEqual(result.matches.map(\.path), ["Sources/Main.swift"])
        XCTAssertEqual(result.matches.first?.queryIDs, ["paths"])
        XCTAssertNil(result.matches.first?.byteRange)

        let recursive = try await service.search(
            .init(
                queries: [.init(id: "recursive", kind: .glob, pattern: "**/Main.swift")],
                ranking: [], byteBudget: 4_096
            ),
            environment: fixture.environment(indexedFiles: [indexed, indexedDecoy])
        )
        XCTAssertEqual(recursive.matches.map(\.path), ["Sources/Main.swift"])
    }

    func testRankingUsesExplicitChangedAndTestBucketsInCallerOrder() async throws {
        let fixture = try SearchFixture()
        defer { fixture.cleanup() }
        for name in ["Changed.swift", "Tests.swift", "Both.swift", "Other.swift"] {
            try "needle\n".write(
                to: fixture.root.appendingPathComponent(name), atomically: true, encoding: .utf8
            )
        }
        let service = try fixture.service()
        let environment = fixture.environment(
            changedPaths: ["Changed.swift", "Both.swift"],
            testPaths: ["Tests.swift", "Both.swift"]
        )
        let changedFirst = try await service.search(
            .init(
                queries: [.init(id: "q", kind: .fixed, pattern: "needle")],
                ranking: [.changed, .tests], changedSinceCursor: environment.observedFrom,
                byteBudget: 8_192
            ),
            environment: environment
        )
        XCTAssertEqual(changedFirst.matches.map(\.path), ["Both.swift", "Changed.swift", "Tests.swift", "Other.swift"])

        let testsFirst = try await service.search(
            .init(
                queries: [.init(id: "q", kind: .fixed, pattern: "needle")],
                ranking: [.tests, .changed], changedSinceCursor: environment.observedFrom,
                byteBudget: 8_192
            ),
            environment: environment
        )
        XCTAssertEqual(testsFirst.matches.map(\.path), ["Both.swift", "Tests.swift", "Changed.swift", "Other.swift"])
    }

    func testOversizedBundleReturnsLosslessArtifactAndContinuationAlwaysAdvances() async throws {
        let fixture = try SearchFixture()
        defer { fixture.cleanup() }
        for index in 0..<2 {
            try ("needle " + String(repeating: "z", count: 3_000) + "\n").write(
                to: fixture.root.appendingPathComponent("Huge\(index).swift"),
                atomically: true,
                encoding: .utf8
            )
        }
        let store = EvidenceStore(baseDirectory: fixture.evidence)
        let service = try SearchContextService(
            resolver: AllowedPathResolver(rootPath: fixture.root.path),
            evidenceStore: store,
            tokenSecret: Data(repeating: 9, count: 32)
        )
        let first = try await service.search(
            .init(
                queries: [.init(id: "q", kind: .fixed, pattern: "needle")],
                ranking: [], maxResults: 2, byteBudget: 1_024
            ),
            environment: fixture.environment()
        )
        let firstDescriptor = try XCTUnwrap(first.oversizedDescriptors.first)
        XCTAssertTrue(first.matches.isEmpty)
        XCTAssertEqual(first.returnedMatches, 1)
        XCTAssertLessThanOrEqual(first.returnedBytes, 512)
        XCTAssertTrue(first.hasMore)
        let firstToken = try XCTUnwrap(first.continuation)
        let artifact = try await store.read(
            handle: firstDescriptor.artifactHandle,
            mode: .range(offset: 0, length: firstDescriptor.artifactSizeBytes),
            byteBudget: firstDescriptor.artifactSizeBytes
        )
        XCTAssertEqual(artifact.returnedBytes, firstDescriptor.artifactSizeBytes)
        XCTAssertEqual(artifact.sha256, firstDescriptor.artifactSHA256)

        let second = try await service.continueSearch(firstToken)
        XCTAssertEqual(second.oversizedDescriptors.count, 1)
        XCTAssertFalse(second.hasMore)
        XCTAssertNil(second.continuation)
        XCTAssertNotEqual(
            firstDescriptor.canonicalIdentity,
            second.oversizedDescriptors.first?.canonicalIdentity
        )
    }
}

private struct SearchFixture {
    let base: URL
    let root: URL
    let evidence: URL

    init() throws {
        base = FileManager.default.temporaryDirectory.appendingPathComponent("AIShellSearchTests-\(UUID().uuidString)")
        root = base.appendingPathComponent("workspace", isDirectory: true)
        evidence = base.appendingPathComponent("evidence", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    }

    func cleanup() {
        try? FileManager.default.removeItem(at: base)
    }

    func service(tokenSecret: Data = Data(repeating: 3, count: 32)) throws -> SearchContextService {
        try SearchContextService(
            resolver: AllowedPathResolver(rootPath: root.path),
            evidenceStore: EvidenceStore(baseDirectory: evidence),
            tokenSecret: tokenSecret
        )
    }

    func environment(
        indexedFiles: [SearchContextIndexedFile]? = [],
        changedPaths: Set<String> = [],
        testPaths: Set<String> = []
    ) -> SearchContextEnvironment {
        SearchContextEnvironment(
            effectiveRootIdentity: "fixture-root",
            effectiveRootPolicyDigest: "fixture-policy",
            workspaceCursor: "cursor-through",
            observedFrom: "cursor-from",
            observedThrough: "cursor-through",
            observationViewID: "view-1",
            changedPaths: changedPaths,
            testPaths: testPaths,
            testClassification: "complete",
            projectProfileDigest: "profile-digest",
            indexedFiles: indexedFiles
        )
    }

    func indexedFile(relativePath: String) throws -> SearchContextIndexedFile {
        let url = root.appendingPathComponent(relativePath)
        let attributes = try FileManager.default.attributesOfItem(atPath: url.path)
        let device = (attributes[.systemNumber] as? NSNumber)?.uint64Value ?? 0
        let inode = (attributes[.systemFileNumber] as? NSNumber)?.uint64Value ?? 0
        let data = try Data(contentsOf: url)
        let digest = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
        return .init(path: relativePath, fileIdentity: "\(device):\(inode)", contentSHA256: digest)
    }
}
