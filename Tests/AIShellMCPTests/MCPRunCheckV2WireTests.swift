import CryptoKit
import AIShellCore
import Foundation
import XCTest
@testable import AIShellMCP

final class MCPRunCheckV2WireTests: XCTestCase {
    func testLegacyAndV2DirectReachRuntimeWithoutChangingV1Shape() async throws {
        let fixture = try await MCPRunCheckWireFixture.make()
        defer { fixture.cleanup() }
        let server = MCPServer(runtimeStore: fixture.store, capabilitySet: "expanded-v1")

        let legacy = await server.callTool(id: .number(1), params: .object([
            "name": .string("run_check"),
            "arguments": .object([
                "executable": .string("/usr/bin/true"),
                "working_directory": .string(fixture.root.path),
                "timeout_seconds": .number(0.1005),
                "retention_seconds": .number(1.5)
            ])
        ]))
        let legacyResult = try XCTUnwrap(legacy.result?.objectValue)
        XCTAssertEqual(legacyResult["isError"], .bool(false))
        XCTAssertEqual(
            legacyResult["structuredContent"]?.objectValue?["schemaVersion"],
            .string("aishell.run-check.v1")
        )

        let v2 = await server.callTool(id: .number(2), params: .object([
            "name": .string("run_check"),
            "arguments": .object(v2Direct(
                executable: "/usr/bin/true",
                workingDirectory: fixture.root.path,
                dispatch: ["mode": .string("sync")]
            ))
        ]))
        let v2Result = try XCTUnwrap(v2.result?.objectValue)
        let structured = try XCTUnwrap(v2Result["structuredContent"]?.objectValue)
        XCTAssertEqual(v2Result["isError"], .bool(false))
        XCTAssertEqual(structured["schemaVersion"], .string("aishell.run-check.v2"))
        XCTAssertEqual(structured["processesStarted"], .number(1))
        XCTAssertEqual(structured["cacheState"], .string("disabled"))
        XCTAssertEqual(structured["steps"]?.arrayValue?.first?.objectValue?["terminalState"], .string("passed"))
    }

    func testStartFailsTypedBeforeResolutionAndStartsNoProcess() async throws {
        let fixture = try await MCPRunCheckWireFixture.make()
        defer { fixture.cleanup() }
        let server = MCPServer(runtimeStore: fixture.store, capabilitySet: "expanded-v1")
        let response = await server.callTool(id: .number(1), params: .object([
            "name": .string("run_check"),
            "arguments": .object(v2Direct(
                executable: "/usr/bin/true",
                workingDirectory: fixture.root.path,
                dispatch: ["mode": .string("start"), "client_run_key": .string("wire-start")]
            ))
        ]))
        let result = try XCTUnwrap(response.result?.objectValue)
        let structured = try XCTUnwrap(result["structuredContent"]?.objectValue)
        XCTAssertEqual(result["isError"], .bool(true))
        XCTAssertEqual(structured["schemaVersion"], .string("aishell.run-check.v2"))
        XCTAssertEqual(structured["error"]?.objectValue?["code"], .string("RUN_CHECK_START_NOT_READY"))
        XCTAssertEqual(structured["error"]?.objectValue?["processesStarted"], .number(0))
    }

    func testChangeImpactAnalyzeRunsThroughExpandedPublicWire() async throws {
        let fixture = try await MCPRunCheckWireFixture.make()
        defer { fixture.cleanup() }
        let source = fixture.root.appendingPathComponent("Changed.swift")
        let bytes = Data("struct Changed {}\n".utf8)
        try bytes.write(to: source)
        let server = MCPServer(runtimeStore: fixture.store, capabilitySet: "expanded-v1")
        let snapshot = await server.callTool(id: .number(1), params: .object([
            "name": .string("workspace_snapshot"),
            "arguments": .object(["path": .string(fixture.root.path)])
        ]))
        let cursor = try XCTUnwrap(
            snapshot.result?.objectValue?["structuredContent"]?.objectValue?["cursor"]?.stringValue
        )
        let digest = SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined()
        let response = await server.callTool(id: .number(2), params: .object([
            "name": .string("change_impact"),
            "arguments": .object([
                "operation": .string("analyze"),
                "root": .string(fixture.root.path),
                "workspace_cursor": .string(cursor),
                "changed_paths": .array([.object([
                    "path": .string("Changed.swift"),
                    "content_sha256": .string(digest)
                ])])
            ])
        ]))
        let result = try XCTUnwrap(response.result?.objectValue)
        XCTAssertEqual(result["isError"], .bool(false))
        XCTAssertEqual(
            result["structuredContent"]?.objectValue?["schemaVersion"],
            .string("aishell.change-impact.v2")
        )
        XCTAssertEqual(result["structuredContent"]?.objectValue?["operation"], .string("analyze"))
    }

    func testRecommendationFocusedSetRunsThroughSameRuntimeWithoutCallerSelectionHash() async throws {
        let fixture = try await MCPRunCheckWireFixture.make()
        defer { fixture.cleanup() }
        let otherRoot = fixture.base.appendingPathComponent("OtherProject", isDirectory: true)
        try FileManager.default.createDirectory(at: otherRoot, withIntermediateDirectories: true)
        try Data("{\"name\":\"other-project\",\"version\":\"1.0.0\"}\n".utf8)
            .write(to: otherRoot.appendingPathComponent("package.json"))
        try await fixture.store.setAllowedRoots([fixture.root, otherRoot])
        let sourceDirectory = fixture.root.appendingPathComponent("Sources/WireFocused", isDirectory: true)
        let testDirectory = fixture.root.appendingPathComponent("Tests/WireFocusedTests", isDirectory: true)
        try FileManager.default.createDirectory(at: sourceDirectory, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: testDirectory, withIntermediateDirectories: true)
        try Data("public struct Changed {}\n".utf8)
            .write(to: sourceDirectory.appendingPathComponent("Changed.swift"))
        try Data("import XCTest\n@testable import WireFocused\nfinal class ChangedTests: XCTestCase {}\n".utf8)
            .write(to: testDirectory.appendingPathComponent("ChangedTests.swift"))
        try Data("""
        // swift-tools-version: 6.0
        import PackageDescription
        let package = Package(
            name: "WireFocused",
            targets: [
                .target(name: "WireFocused"),
                .testTarget(name: "WireFocusedTests", dependencies: ["WireFocused"])
            ]
        )
        """.utf8).write(to: fixture.root.appendingPathComponent("Package.swift"))

        let workspace = WorkspaceStateRuntime(runtimeStore: fixture.store, startsFSEvents: false)
        let evidence = EvidenceStore(baseDirectory: fixture.base.appendingPathComponent("evidence"))
        let focused = FocusedCheckService()
        let profiles = ProjectProfileService(
            runtimeStore: fixture.store,
            workspaceRuntime: workspace,
            evidenceStore: evidence
        )
        let development = DevelopmentRuntimeService(
            runtimeStore: fixture.store,
            evidenceStore: evidence,
            workspaceRuntime: workspace,
            focusedChecks: focused,
            projectProfiles: profiles
        )
        let otherSnapshot = try await workspace.snapshot(path: otherRoot.path, contextBudget: 0)
        _ = try await profiles.catalog(for: otherSnapshot)
        let snapshot = try await workspace.snapshot(path: fixture.root.path, contextBudget: 0)
        let catalog = try await profiles.catalog(for: snapshot)
        let profile = try XCTUnwrap(catalog.profiles.first)
        let changedBytes = try Data(contentsOf: sourceDirectory.appendingPathComponent("Changed.swift"))
        let changedDigest = SHA256.hash(data: changedBytes).map { String(format: "%02x", $0) }.joined()
        let server = MCPServer(
            runtimeStore: fixture.store,
            capabilitySet: "expanded-v1",
            developmentRuntime: development
        )

        let recommendation = await server.callTool(id: .number(1), params: .object([
            "name": .string("change_impact"),
            "arguments": .object([
                "operation": .string("recommend"),
                "root": .string(fixture.root.path),
                "workspace_cursor": .string(catalog.observedCursor),
                "changed_paths": .array([.object([
                    "path": .string("Sources/WireFocused/Changed.swift"),
                    "content_sha256": .string(changedDigest)
                ])]),
                "project_id": .string(profile.projectId),
                "profile_digest": .string(profile.profileDigest),
                "byte_budget": .number(1_048_576)
            ])
        ]))
        let recommendationResult = try XCTUnwrap(recommendation.result?.objectValue)
        let recommended = try XCTUnwrap(recommendationResult["structuredContent"]?.objectValue)
        guard recommendationResult["isError"] == .bool(false) else {
            return XCTFail("recommend failed: \(recommended)")
        }
        let focusedSetID = try XCTUnwrap(recommended["focusedSetID"]?.stringValue)
        let focusedSetDigest = try XCTUnwrap(recommended["focusedSetDigest"]?.stringValue)
        let items = try XCTUnwrap(recommended["items"]?.arrayValue)
        let candidateID: String = try XCTUnwrap(items.compactMap { item -> String? in
            guard item.objectValue?["kind"] == .string("focused_candidate") else { return nil }
            return item.objectValue?["focusedCheckID"]?.stringValue
        }.first)

        let run = await server.callTool(id: .number(2), params: .object([
            "name": .string("run_check"),
            "arguments": .object([
                "schema": .string("aishell.run-check.v2"),
                "invocation": .object([
                    "mode": .string("focused_set"),
                    "focused_set_id": .string(focusedSetID),
                    "ordered_check_ids": .array([.string(candidateID)])
                ]),
                "dispatch": .object(["mode": .string("sync")]),
                "cache": .string("off"),
                "execution_policy": .object([
                    "timeout_ms": .number(5_000),
                    "retention_seconds": .number(3_600)
                ]),
                "selection": .object([
                    "binding": .string("prepare_focused_set"),
                    "focused_set_digest": .string(focusedSetDigest)
                ])
            ])
        ]))
        let runResult = try XCTUnwrap(run.result?.objectValue)
        let runStructured = try XCTUnwrap(runResult["structuredContent"]?.objectValue)
        XCTAssertEqual(runResult["isError"], .bool(false))
        XCTAssertEqual(runStructured["schemaVersion"], .string("aishell.run-check.v2"))
        XCTAssertEqual(runStructured["requestedCheckIDs"], .array([.string(candidateID)]))
        XCTAssertEqual(runStructured["processesStarted"], .number(1))
        let selectionDigest = try XCTUnwrap(runStructured["selectionDigest"]?.stringValue)

        let verified = await server.callTool(id: .number(3), params: .object([
            "name": .string("run_check"),
            "arguments": .object([
                "schema": .string("aishell.run-check.v2"),
                "invocation": .object([
                    "mode": .string("focused_set"),
                    "focused_set_id": .string(focusedSetID),
                    "ordered_check_ids": .array([.string(candidateID)])
                ]),
                "dispatch": .object(["mode": .string("sync")]),
                "cache": .string("off"),
                "execution_policy": .object([
                    "timeout_ms": .number(5_000),
                    "retention_seconds": .number(3_600)
                ]),
                "selection": .object([
                    "binding": .string("verify_focused_set"),
                    "focused_set_digest": .string(focusedSetDigest),
                    "selection_digest": .string(selectionDigest)
                ])
            ])
        ]))
        let verifiedResult = try XCTUnwrap(verified.result?.objectValue)
        XCTAssertEqual(verifiedResult["isError"], .bool(false))
        XCTAssertEqual(
            verifiedResult["structuredContent"]?.objectValue?["selectionDigest"],
            .string(selectionDigest)
        )

        try await profiles.invalidateAll()
        let stale = await server.callTool(id: .number(4), params: .object([
            "name": .string("run_check"),
            "arguments": .object([
                "schema": .string("aishell.run-check.v2"),
                "invocation": .object([
                    "mode": .string("focused_set"),
                    "focused_set_id": .string(focusedSetID),
                    "ordered_check_ids": .array([.string(candidateID)])
                ]),
                "dispatch": .object(["mode": .string("sync")]),
                "cache": .string("off"),
                "execution_policy": .object([
                    "timeout_ms": .number(5_000),
                    "retention_seconds": .number(3_600)
                ]),
                "selection": .object([
                    "binding": .string("verify_focused_set"),
                    "focused_set_digest": .string(focusedSetDigest),
                    "selection_digest": .string(selectionDigest)
                ])
            ])
        ]))
        let staleResult = try XCTUnwrap(stale.result?.objectValue)
        let staleStructured = try XCTUnwrap(staleResult["structuredContent"]?.objectValue)
        XCTAssertEqual(staleResult["isError"], .bool(true))
        XCTAssertEqual(staleStructured["error"]?.objectValue?["code"], .string("RUN_CHECK_SELECTION_STALE"))
        XCTAssertEqual(staleStructured["error"]?.objectValue?["processesStarted"], .number(0))
    }

    private func v2Direct(
        executable: String,
        workingDirectory: String,
        dispatch: [String: JSONValue]
    ) -> [String: JSONValue] {
        [
            "schema": .string("aishell.run-check.v2"),
            "invocation": .object([
                "mode": .string("direct"),
                "executable": .string(executable),
                "working_directory": .string(workingDirectory)
            ]),
            "dispatch": .object(dispatch),
            "cache": .string("off"),
            "execution_policy": .object([
                "timeout_ms": .number(5_000),
                "retention_seconds": .number(3_600)
            ]),
            "selection": .object(["binding": .string("prepare")])
        ]
    }
}

private final class MCPRunCheckWireFixture {
    let base: URL
    let root: URL
    let store: RuntimeStore

    private init() throws {
        base = FileManager.default.temporaryDirectory
            .appendingPathComponent("aishell-run-check-wire-\(UUID().uuidString)", isDirectory: true)
        root = base.appendingPathComponent("workspace", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        store = RuntimeStore(baseDirectory: base.appendingPathComponent("runtime", isDirectory: true))
    }

    static func make() async throws -> MCPRunCheckWireFixture {
        let fixture = try MCPRunCheckWireFixture()
        try await fixture.store.setAllowedRoot(fixture.root)
        return fixture
    }

    func cleanup() { try? FileManager.default.removeItem(at: base) }
}
