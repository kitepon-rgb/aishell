import XCTest
@testable import AIShellMCP

final class MCPTypesTests: XCTestCase {
    func testDevelopmentProfileListsOnlyHighDensitySurfaceAndRuntimeEntry() {
        let tools = ToolCatalog.listedTools(profile: nil)
        XCTAssertEqual(
            Set(tools.map(\.name)),
            [
                "run_check", "artifact_read", "workspace_snapshot", "read_context", "search_context"
            ]
        )
        XCTAssertEqual(tools.prefix(5).map(\.name), [
            "run_check", "artifact_read", "workspace_snapshot", "read_context", "search_context"
        ])
        XCTAssertTrue(tools.prefix(5).allSatisfy { $0.outputSchema != nil })
        XCTAssertTrue(tools.prefix(5).allSatisfy {
            $0.outputSchema?.objectValue?["type"] == .string("object")
                && $0.outputSchema?.objectValue?["oneOf"]?.arrayValue?.count == 2
        })
        XCTAssertEqual(tools.first { $0.name == "run_check" }?.annotations.destructiveHint, true)
        XCTAssertEqual(tools.first { $0.name == "run_check" }?.annotations.openWorldHint, true)
        let snapshot = tools.first { $0.name == "workspace_snapshot" }
        let entryLimit = snapshot?.inputSchema.objectValue?["properties"]?.objectValue?["entry_limit"]?.objectValue
        XCTAssertEqual(entryLimit?["minimum"], .number(1))
        XCTAssertEqual(entryLimit?["maximum"], .number(5_000))
        let success = snapshot?.outputSchema?.objectValue?["oneOf"]?.arrayValue?.first?.objectValue
        XCTAssertEqual(success?["properties"]?.objectValue?["schemaVersion"]?.objectValue?["const"], .string("aishell.workspace-snapshot.v1"))
        XCTAssertEqual(success?["properties"]?.objectValue?["omittedEntries"]?.objectValue?["type"], .string("integer"))
    }

    func testFullProfileRetainsLegacyDiscoveryCompatibility() {
        let names = Set(ToolCatalog.listedTools(profile: "full").map(\.name))
        XCTAssertTrue(names.contains("process_run"))
        XCTAssertTrue(names.contains("files_read_text"))
        XCTAssertTrue(names.isSuperset(of: ToolCatalog.developmentToolNames))
    }

    func testArtifactStructuredProjectionDoesNotDuplicatePayload() {
        let projected = MCPServer().structuredProjection(
            name: "artifact_read",
            result: .object([
                "encoding": .string("base64"),
                "base64": .string("AP9B"),
                "text": .string("payload"),
                "returnedBytes": .number(3)
            ])
        )

        XCTAssertNil(projected.objectValue?["text"])
        XCTAssertNil(projected.objectValue?["base64"])
        XCTAssertEqual(projected.objectValue?["encoding"], .string("base64"))
    }

    func testContextStructuredProjectionsDoNotDuplicateModelFacingText() {
        let cases: [(String, String)] = [
            ("workspace_snapshot", "context"),
            ("read_context", "chunks"),
            ("search_context", "matches")
        ]
        for (name, key) in cases {
            let projected = MCPServer().structuredProjection(
                name: name,
                result: .object([
                    key: .array([.object([
                        "path": .string("Sources/App.swift"),
                        "line": .number(7),
                        "text": .string(String(repeating: "payload", count: 10_000))
                    ])])
                ])
            )
            let item = projected.objectValue?[key]?.arrayValue?.first?.objectValue
            XCTAssertNil(item?["text"], "\(name) duplicated TextContent in structuredContent")
            XCTAssertEqual(item?["path"], .string("Sources/App.swift"))
        }
    }
}
