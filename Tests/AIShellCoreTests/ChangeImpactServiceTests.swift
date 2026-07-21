import CryptoKit
import Foundation
import XCTest
@testable import AIShellCore

final class ChangeImpactServiceTests: XCTestCase {
    func testDuplicateCandidateRetainsEveryProviderProvenanceDeterministically() async throws {
        let fixture = try ImpactFixture()
        defer { fixture.cleanup() }
        let sourceSHA = try fixture.write("Sources/App/Changed.swift", "struct Changed {}\n")
        let referenceSHA = try fixture.write("Sources/App/Use.swift", "let value = Changed()\n")
        let binding = ChangeImpactFreshnessBinding(
            role: .analysis,
            path: "Sources/App/Use.swift",
            contentSHA256: referenceSHA
        )
        let candidate = ChangeImpactCandidateSeed(
            category: .references,
            subject: .path("Sources/App/Use.swift")
        )
        let lexical = StubImpactProvider(
            id: "lexical",
            kind: .lexicalSearch,
            binding: binding,
            evidence: .init(
                inputIdentity: "changed:Changed.swift",
                candidate: candidate,
                relation: .lexicalReference,
                locator: .init(
                    path: "Sources/App/Use.swift",
                    contentSHA256: referenceSHA,
                    startOffset: 12,
                    endOffset: 19
                ),
                strength: .lexicalMatch,
                summary: "Changedのtoken一致"
            )
        )
        let index = StubImpactProvider(
            id: "workspace-index",
            kind: .workspaceIndex,
            binding: binding,
            evidence: .init(
                inputIdentity: "changed:Changed.swift",
                candidate: candidate,
                relation: .containsSource,
                locator: .init(
                    path: "Sources/App/Use.swift",
                    contentSHA256: referenceSHA,
                    edgeID: "source:Use.swift"
                ),
                strength: .declaredEdge,
                summary: "workspace indexのsource所属"
            )
        )
        let runtime = try await fixture.runtime()
        let request = ChangeImpactRequest(
            root: fixture.root.path,
            workspaceCursor: runtime.cursor,
            changedPaths: [.init(path: "Sources/App/Changed.swift", contentSHA256: sourceSHA)],
            requiredProviders: ["lexical", "workspace-index"],
            byteBudget: 1_048_576
        )
        let firstStore = fixture.evidenceStore(suffix: "first")
        let first = try await ChangeImpactService(
            runtimeStore: runtime.store,
            workspaceRuntime: runtime.workspace,
            evidenceStore: firstStore,
            providers: [index, lexical]
        ).analyze(request)

        XCTAssertEqual(first.coverage, "complete")
        XCTAssertEqual(first.counts.references, 1)
        XCTAssertEqual(first.items.filter { $0.kind == .candidate }.count, 1)
        XCTAssertEqual(first.items.filter { $0.kind == .evidence }.count, 2)
        XCTAssertEqual(first.items.filter { $0.kind == .candidateEvidence }.count, 2)
        XCTAssertEqual(
            Set(first.items.compactMap { $0.kind == .evidence ? $0.providerID : nil }),
            ["lexical", "workspace-index"]
        )
        XCTAssertEqual(first.freshness.bindingCount, 2)

        let second = try await ChangeImpactService(
            runtimeStore: runtime.store,
            workspaceRuntime: runtime.workspace,
            evidenceStore: fixture.evidenceStore(suffix: "second"),
            providers: [lexical, index]
        ).analyze(ChangeImpactRequest(
            root: fixture.root.path,
            workspaceCursor: runtime.cursor,
            changedPaths: [.init(path: "Sources/App/Changed.swift", contentSHA256: sourceSHA)],
            requiredProviders: ["workspace-index", "lexical"],
            byteBudget: 1_048_576
        ))
        XCTAssertEqual(first.items, second.items)
        XCTAssertEqual(first.artifact.sha256, second.artifact.sha256)
        XCTAssertEqual(first.freshness.bindingDigest, second.freshness.bindingDigest)
    }

    func testAnalysisMutationFailsClosedBeforeReturningCandidates() async throws {
        let fixture = try ImpactFixture()
        defer { fixture.cleanup() }
        let sourceSHA = try fixture.write("Changed.swift", "struct Changed {}\n")
        let referenceSHA = try fixture.write("Use.swift", "let value = Changed()\n")
        let provider = StubImpactProvider(
            id: "lexical",
            kind: .lexicalSearch,
            binding: .init(role: .analysis, path: "Use.swift", contentSHA256: referenceSHA),
            evidence: .init(
                inputIdentity: "changed",
                candidate: .init(category: .references, subject: .path("Use.swift")),
                relation: .lexicalReference,
                locator: .init(path: "Use.swift", contentSHA256: referenceSHA, startOffset: 12, endOffset: 19),
                strength: .lexicalMatch,
                summary: "token一致"
            )
        )
        let runtime = try await fixture.runtime()
        let changingURL = fixture.root.appendingPathComponent("Use.swift")
        let service = ChangeImpactService(
            runtimeStore: runtime.store,
            workspaceRuntime: runtime.workspace,
            evidenceStore: fixture.evidenceStore(),
            providers: [provider],
            beforeFinalFreshnessCheck: {
                try Data("let value = Other()\n".utf8).write(to: changingURL, options: .atomic)
            }
        )

        await XCTAssertThrowsImpactError(
            try await service.analyze(ChangeImpactRequest(
                root: fixture.root.path,
                workspaceCursor: runtime.cursor,
                changedPaths: [.init(path: "Changed.swift", contentSHA256: sourceSHA)]
            ))
        ) { error in
            guard case .contentChanged("Use.swift") = error else {
                return XCTFail("想定外のerror: \(error)")
            }
        }
    }

    func testContinuationRevalidatesAllFreshnessBindings() async throws {
        let fixture = try ImpactFixture()
        defer { fixture.cleanup() }
        let sourceSHA = try fixture.write("Changed.swift", "struct Changed {}\n")
        let referenceSHA = try fixture.write("Use.swift", "let value = Changed()\n")
        let provider = StubImpactProvider(
            id: "lexical",
            kind: .lexicalSearch,
            binding: .init(role: .analysis, path: "Use.swift", contentSHA256: referenceSHA),
            evidence: .init(
                inputIdentity: "changed",
                candidate: .init(category: .references, subject: .path("Use.swift")),
                relation: .lexicalReference,
                locator: .init(path: "Use.swift", contentSHA256: referenceSHA, startOffset: 12, endOffset: 19),
                strength: .lexicalMatch,
                summary: "token一致"
            )
        )
        let runtime = try await fixture.runtime()
        let service = ChangeImpactService(
            runtimeStore: runtime.store,
            workspaceRuntime: runtime.workspace,
            evidenceStore: fixture.evidenceStore(),
            providers: [provider]
        )
        let first = try await service.analyze(ChangeImpactRequest(
            root: fixture.root.path,
            workspaceCursor: runtime.cursor,
            changedPaths: [.init(path: "Changed.swift", contentSHA256: sourceSHA)],
            byteBudget: 512
        ))
        let token = try XCTUnwrap(first.continuation)
        _ = try fixture.write("Use.swift", "let value = Other()\n")

        await XCTAssertThrowsImpactError(
            try await service.analyze(ChangeImpactRequest(
                operation: nil,
                byteBudget: 1_024,
                continuation: token
            ))
        ) { error in
            guard case .contentChanged("Use.swift") = error else {
                return XCTFail("想定外のerror: \(error)")
            }
        }
    }

    func testRequiredProviderMustBeFreshAndDoesNotFallback() async throws {
        let fixture = try ImpactFixture()
        defer { fixture.cleanup() }
        let sourceSHA = try fixture.write("Changed.swift", "struct Changed {}\n")
        let runtime = try await fixture.runtime()
        let stale = StubImpactProvider(
            id: "sourcekit",
            kind: .sourceKit,
            status: .stale,
            reasonCode: "DOCUMENT_VERSION_MISMATCH"
        )
        let service = ChangeImpactService(
            runtimeStore: runtime.store,
            workspaceRuntime: runtime.workspace,
            evidenceStore: fixture.evidenceStore(),
            providers: [stale]
        )

        await XCTAssertThrowsImpactError(
            try await service.analyze(ChangeImpactRequest(
                root: fixture.root.path,
                workspaceCursor: runtime.cursor,
                changedPaths: [.init(path: "Changed.swift", contentSHA256: sourceSHA)],
                requiredProviders: ["sourcekit"]
            ))
        ) { error in
            XCTAssertEqual(error, .requiredProviderNotFresh(["sourcekit"]))
        }
    }

    func testFilesystemProviderReturnsLexicalTestAndTargetEvidenceWithoutExecution() async throws {
        let fixture = try ImpactFixture()
        defer { fixture.cleanup() }
        _ = try fixture.write("Package.swift", "// swift-tools-version: 6.0\n")
        let sourceSHA = try fixture.write("Sources/App/Widget.swift", "struct Widget {}\n")
        _ = try fixture.write("Sources/App/Use.swift", "let value = Widget()\n")
        _ = try fixture.write("Tests/AppTests/WidgetTests.swift", "func testWidget() {}\n")
        let runtime = try await fixture.runtime()
        let result = try await ChangeImpactService(
            runtimeStore: runtime.store,
            workspaceRuntime: runtime.workspace,
            evidenceStore: fixture.evidenceStore()
        ).analyze(ChangeImpactRequest(
            root: fixture.root.path,
            workspaceCursor: runtime.cursor,
            changedPaths: [.init(path: "Sources/App/Widget.swift", contentSHA256: sourceSHA)],
            changedSymbols: [.init(
                path: "Sources/App/Widget.swift",
                contentSHA256: sourceSHA,
                name: "Widget",
                startOffset: 7,
                endOffset: 13
            )],
            requiredProviders: ["aishell.filesystem-impact"],
            byteBudget: 1_048_576
        ))

        XCTAssertGreaterThanOrEqual(result.counts.references, 1)
        XCTAssertGreaterThanOrEqual(result.counts.relatedTests, 1)
        XCTAssertEqual(result.counts.buildTargets, 1)
        XCTAssertTrue(result.items.contains {
            $0.kind == .evidence && $0.evidenceStrength == .declaredEdge
        })
        XCTAssertEqual(result.coverage, "complete")
    }
}

private struct StubImpactProvider: ChangeImpactProvider {
    let descriptor: ChangeImpactProviderDescriptor
    let status: ChangeImpactProviderStatus
    let reasonCode: String?
    let binding: ChangeImpactFreshnessBinding?
    let evidence: ChangeImpactEvidenceSeed?

    init(
        id: String,
        kind: ChangeImpactProviderKind,
        status: ChangeImpactProviderStatus = .fresh,
        reasonCode: String? = nil,
        binding: ChangeImpactFreshnessBinding? = nil,
        evidence: ChangeImpactEvidenceSeed? = nil
    ) {
        descriptor = .init(providerID: id, kind: kind, version: "test-1")
        self.status = status
        self.reasonCode = reasonCode
        self.binding = binding
        self.evidence = evidence
    }

    func analyze(_ input: ChangeImpactProviderInput) async throws -> ChangeImpactProviderOutput {
        ChangeImpactProviderOutput(
            report: .init(
                descriptor: descriptor,
                status: status,
                inputDigest: String(repeating: "a", count: 64),
                observedAtCursor: input.workspaceCursor,
                reasonCode: reasonCode,
                nextAction: status == .fresh ? nil : "providerを再同期してください。"
            ),
            evidence: evidence.map { [$0] } ?? [],
            freshnessBindings: binding.map { [$0] } ?? []
        )
    }
}

private final class ImpactFixture: @unchecked Sendable {
    let base: URL
    let root: URL

    init() throws {
        base = FileManager.default.temporaryDirectory
            .appendingPathComponent("AIShellChangeImpact-\(UUID().uuidString)", isDirectory: true)
        root = base.appendingPathComponent("workspace", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    }

    func write(_ relativePath: String, _ text: String) throws -> String {
        let url = root.appendingPathComponent(relativePath)
        try FileManager.default.createDirectory(
            at: url.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        let data = Data(text.utf8)
        try data.write(to: url, options: .atomic)
        return SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }

    func runtime(suffix: String = "default") async throws -> (
        store: RuntimeStore,
        workspace: WorkspaceStateRuntime,
        cursor: String
    ) {
        let store = RuntimeStore(baseDirectory: base.appendingPathComponent("runtime-\(suffix)"))
        try await store.setAllowedRoot(root)
        let workspace = WorkspaceStateRuntime(runtimeStore: store, startsFSEvents: false)
        let snapshot = try await workspace.snapshot(path: root.path, contextBudget: 0)
        return (store, workspace, snapshot.cursor)
    }

    func evidenceStore(suffix: String = "default") -> EvidenceStore {
        EvidenceStore(baseDirectory: base.appendingPathComponent("evidence-\(suffix)", isDirectory: true))
    }

    func cleanup() { try? FileManager.default.removeItem(at: base) }
}

private func XCTAssertThrowsImpactError<T>(
    _ expression: @autoclosure () async throws -> T,
    file: StaticString = #filePath,
    line: UInt = #line,
    _ inspect: (ChangeImpactError) -> Void
) async {
    do {
        _ = try await expression()
        XCTFail("errorになりませんでした。", file: file, line: line)
    } catch let error as ChangeImpactError {
        inspect(error)
    } catch {
        XCTFail("想定外のerror: \(error)", file: file, line: line)
    }
}
