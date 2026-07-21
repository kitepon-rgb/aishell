import AIShellCore
import Foundation
import XCTest
@testable import AIShellMCP

final class MCPContextV2WireTests: XCTestCase {
    func testProjectProfileContinuationRoundTripsThroughMCP() async throws {
        let temporary = FileManager.default.temporaryDirectory
            .appendingPathComponent("aishell-mcp-profile-page-\(UUID().uuidString)", isDirectory: true)
        let root = temporary.appendingPathComponent("workspace", isDirectory: true)
        let nested = root.appendingPathComponent("Nested", isDirectory: true)
        try FileManager.default.createDirectory(at: nested, withIntermediateDirectories: true)
        try Data("[package]\nname=\"root\"\nversion=\"0.1.0\"\n".utf8)
            .write(to: root.appendingPathComponent("Cargo.toml"))
        try Data("[package]\nname=\"nested\"\nversion=\"0.1.0\"\n".utf8)
            .write(to: nested.appendingPathComponent("Cargo.toml"))
        defer { try? FileManager.default.removeItem(at: temporary) }
        let store = RuntimeStore(baseDirectory: temporary.appendingPathComponent("state"))
        try await store.setAllowedRoot(root)
        let server = MCPServer(runtimeStore: store)

        let first = await server.callTool(id: .number(1), params: .object([
            "name": .string("workspace_snapshot"),
            "arguments": .object([
                "path": .string(root.path),
                "project_profile": .object([
                    "mode": .string("all"),
                    "byte_budget": .number(262_144),
                    "profile_limit": .number(1)
                ])
            ])
        ]))
        let firstStructured = try XCTUnwrap(
            first.result?.objectValue?["structuredContent"]?.objectValue
        )
        let continuation = try XCTUnwrap(firstStructured["projectProfileContinuation"]?.stringValue)
        XCTAssertEqual(firstStructured["projectProfileHasMore"], .bool(true))

        let second = await server.callTool(id: .number(2), params: .object([
            "name": .string("workspace_snapshot"),
            "arguments": .object([
                "path": .string(root.path),
                "project_profile": .object([
                    "continuation": .string(continuation),
                    "byte_budget": .number(262_144),
                    "profile_limit": .number(1)
                ])
            ])
        ]))
        let secondStructured = try XCTUnwrap(
            second.result?.objectValue?["structuredContent"]?.objectValue
        )
        XCTAssertEqual(second.result?.objectValue?["isError"], .bool(false))
        XCTAssertEqual(secondStructured["projectProfileHasMore"], .bool(false))
        XCTAssertEqual(secondStructured["cursor"], firstStructured["cursor"])
    }

    func testWorkspaceV2ProjectionAndSearchV2FailureUseStableWireShapes() async throws {
        let temporary = FileManager.default.temporaryDirectory
            .appendingPathComponent("aishell-mcp-context-v2-\(UUID().uuidString)", isDirectory: true)
        let root = temporary.appendingPathComponent("workspace", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        try Data("needle\n".utf8).write(to: root.appendingPathComponent("Source.swift"))
        defer { try? FileManager.default.removeItem(at: temporary) }
        let store = RuntimeStore(baseDirectory: temporary.appendingPathComponent("state"))
        try await store.setAllowedRoot(root)
        let server = MCPServer(runtimeStore: store)

        let workspace = await server.callTool(id: .number(1), params: .object([
            "name": .string("workspace_snapshot"),
            "arguments": .object([
                "path": .string(root.path),
                "project_profile": .object(["mode": .string("none")])
            ])
        ]))
        let workspaceResult = try XCTUnwrap(workspace.result?.objectValue)
        XCTAssertEqual(workspaceResult["isError"], .bool(false))
        XCTAssertEqual(
            workspaceResult["structuredContent"]?.objectValue?["schemaVersion"],
            .string("aishell.workspace-snapshot.v2")
        )
        let cursor = try XCTUnwrap(
            workspaceResult["structuredContent"]?.objectValue?["cursor"]?.stringValue
        )
        let search = await server.callTool(id: .number(2), params: .object([
            "name": .string("search_context"),
            "arguments": .object([
                "action": .string("search"),
                "path": .string(root.path),
                "changed_since_cursor": .string(cursor),
                "ranking": .array([.string("changed")]),
                "queries": .array([.object([
                    "id": .string("q0"), "kind": .string("fixed"), "pattern": .string("needle")
                ])])
            ])
        ]))
        let searchResult = try XCTUnwrap(search.result?.objectValue)
        XCTAssertEqual(searchResult["isError"], .bool(false))
        XCTAssertEqual(
            searchResult["structuredContent"]?.objectValue?["schema"],
            .string("aishell.search-context.v2")
        )
        XCTAssertEqual(
            searchResult["structuredContent"]?.objectValue?["matches"]?.arrayValue?.count,
            1
        )

        let invalidSearch = await server.callTool(id: .number(3), params: .object([
            "name": .string("search_context"),
            "arguments": .object([
                "action": .string("search"),
                "path": .string(root.path),
                "queries": .array([.object([
                    "id": .string("q0"), "kind": .string("fixed"), "pattern": .string("needle")
                ])])
            ])
        ]))
        let invalidResult = try XCTUnwrap(invalidSearch.result?.objectValue)
        XCTAssertEqual(invalidResult["isError"], .bool(true))
        XCTAssertEqual(
            invalidResult["structuredContent"]?.objectValue?["error"]?.objectValue?["code"],
            .string("INVALID_ARGUMENT")
        )
    }

    func testToolSchemasAdvertiseNestedV2ContextWithoutRemovingV1Fields() throws {
        let tools = ToolCatalog.listedTools(profile: nil)
        let workspace = try XCTUnwrap(tools.first { $0.name == "workspace_snapshot" })
        let workspaceProperties = try XCTUnwrap(workspace.inputSchema.objectValue?["properties"]?.objectValue)
        XCTAssertNotNil(workspaceProperties["git_diff"])
        XCTAssertNotNil(workspaceProperties["project_profile"])
        XCTAssertNotNil(workspaceProperties["since_cursor"])

        let search = try XCTUnwrap(tools.first { $0.name == "search_context" })
        let searchProperties = try XCTUnwrap(search.inputSchema.objectValue?["properties"]?.objectValue)
        XCTAssertNotNil(searchProperties["query"])
        XCTAssertNotNil(searchProperties["queries"])
        XCTAssertNotNil(searchProperties["changed_since_cursor"])
        let profileProperties = workspaceProperties["project_profile"]?.objectValue?["properties"]?.objectValue
        XCTAssertNotNil(profileProperties?["byte_budget"])
        XCTAssertNotNil(profileProperties?["profile_limit"])
        XCTAssertNotNil(profileProperties?["continuation"])
    }
}
