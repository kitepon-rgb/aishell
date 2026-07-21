import AIShellCore
import XCTest
@testable import AIShellMCP

final class MCPApplyChangeSetWireTests: XCTestCase {
    func testApplyChangeSetSchemaIsClosedDestructiveAndIdempotent() throws {
        let tools = try ToolCatalog.listedTools(profile: nil, capabilitySet: "expanded-v1")
        let tool = try XCTUnwrap(tools.first { $0.name == "apply_change_set" })
        XCTAssertTrue(tool.annotations.destructiveHint)
        XCTAssertTrue(tool.annotations.idempotentHint)
        XCTAssertFalse(tool.annotations.readOnlyHint)

        let input = try XCTUnwrap(tool.inputSchema.objectValue)
        XCTAssertEqual(input["additionalProperties"], .bool(false))
        let properties = try XCTUnwrap(input["properties"]?.objectValue)
        XCTAssertEqual(properties["changes"]?.objectValue?["minItems"], .number(1))
        XCTAssertEqual(properties["changes"]?.objectValue?["maxItems"], .number(128))
        let variants = properties["changes"]?.objectValue?["items"]?.objectValue?["oneOf"]?.arrayValue
        XCTAssertEqual(variants?.count, 4)
        XCTAssertTrue(variants?.allSatisfy { $0.objectValue?["additionalProperties"] == .bool(false) } == true)
        let rename = variants?.last?.objectValue?["properties"]?.objectValue
        XCTAssertNotNil(rename?["source_expected"])
        XCTAssertNotNil(rename?["destination_expected"])

        let success = tool.outputSchema?.objectValue?["oneOf"]?.arrayValue?.first?.objectValue
        XCTAssertEqual(
            success?["properties"]?.objectValue?["schemaVersion"]?.objectValue?["const"],
            .string("aishell.apply-change-set.v1")
        )
    }

    func testInvalidOperationFailsBeforeFilesystemOrServiceFallback() async throws {
        let server = MCPServer(capabilitySet: "expanded-v1")
        let response = await server.callTool(id: .number(1), params: .object([
            "name": .string("apply_change_set"),
            "arguments": .object([
                "client_id": .string("00000000-0000-4000-8000-000000000001"),
                "client_epoch": .number(1),
                "request_sequence": .number(1),
                "cursor": .object([
                    "root": .string("/tmp/not-consulted"),
                    "generation": .string("generation"),
                    "sequence": .number(0)
                ]),
                "changes": .array([.object([
                    "change_id": .string("c1"),
                    "operation": .string("patch"),
                    "path": .string("one.txt"),
                    "expected": .object(["state": .string("absent")]),
                    "content": .object(["encoding": .string("utf8"), "data": .string("one")])
                ])])
            ])
        ]))
        let result = try XCTUnwrap(response.result?.objectValue)
        XCTAssertEqual(result["isError"], .bool(true))
        XCTAssertEqual(
            result["structuredContent"]?.objectValue?["error"]?.objectValue?["code"],
            .string("INVALID_ARGUMENT")
        )
    }

    func testOperationSpecificFieldsAreNotSilentlyIgnored() async throws {
        let server = MCPServer(capabilitySet: "expanded-v1")
        let response = await server.callTool(id: .number(2), params: .object([
            "name": .string("apply_change_set"),
            "arguments": .object([
                "client_id": .string("00000000-0000-4000-8000-000000000001"),
                "client_epoch": .number(1),
                "request_sequence": .number(1),
                "cursor": .object([
                    "root": .string("/tmp/not-consulted"),
                    "generation": .string("generation"),
                    "sequence": .number(0)
                ]),
                "changes": .array([.object([
                    "change_id": .string("c1"),
                    "operation": .string("delete"),
                    "path": .string("one.txt"),
                    "expected": .object([
                        "state": .string("file"),
                        "sha256": .string(String(repeating: "0", count: 64))
                    ]),
                    "content": .object(["encoding": .string("utf8"), "data": .string("ignored")])
                ])])
            ])
        ]))
        XCTAssertEqual(
            response.result?.objectValue?["structuredContent"]?.objectValue?["error"]?
                .objectValue?["code"],
            .string("INVALID_ARGUMENT")
        )
    }

    func testApplyChangeSetErrorsKeepStableCodes() {
        let server = MCPServer()
        XCTAssertEqual(
            server.stableError(ApplyChangeSetError(.changeSetRecoveryRequired)).code,
            "CHANGE_SET_RECOVERY_REQUIRED"
        )
        XCTAssertEqual(
            server.stableError(ApplyChangeSetError(.externalConflictDuringCommit)).code,
            "EXTERNAL_CONFLICT_DURING_COMMIT"
        )
        XCTAssertEqual(
            server.stableError(ApplyChangeSetError(.changeSetReservationCorrupt)).code,
            "CHANGE_SET_RESERVATION_CORRUPT"
        )
        XCTAssertEqual(
            server.stableError(ApplyChangeSetError(.changeSetPreviousPending)).code,
            "CHANGE_SET_PREVIOUS_PENDING"
        )
        XCTAssertEqual(
            server.stableError(ApplyChangeSetError(.clientEpochExhausted)).code,
            "CLIENT_EPOCH_EXHAUSTED"
        )

        let error = ApplyChangeSetError(
            .changeSetRecoveryRequired,
            "回復が必要です。",
            context: ApplyChangeSetFailureContext(
                transactionID: "tx-1",
                clientID: "00000000-0000-4000-8000-000000000001",
                clientEpoch: 2,
                requestSequence: 7,
                changedPaths: ["one.txt"],
                rollbackState: "not_proven",
                recoveryState: "recovery_required",
                evidenceHandle: "art_1",
                nextAction: "retry_apply_change_set"
            )
        )
        let stable = server.stableError(error)
        let structured = server.structuredError(error, stable: stable).objectValue
        XCTAssertEqual(structured?["transaction_id"], .string("tx-1"))
        XCTAssertEqual(structured?["changed_paths"], .array([.string("one.txt")]))
        XCTAssertEqual(structured?["next_action"], .string("retry_apply_change_set"))
    }

    func testSuccessProjectionUsesADR0017WireNamesWithoutDroppingEvidence() throws {
        let cursor = ApplyChangeSetCursor(root: "/workspace", generation: "g1", sequence: 4)
        let result = ApplyChangeSetResult(
            transactionID: "tx-1",
            clientID: "00000000-0000-4000-8000-000000000001",
            clientEpoch: 2,
            root: "/workspace",
            status: .committed,
            visibility: .aishellSerializedRecoverable,
            requestSequence: 7,
            fromCursor: cursor,
            cursor: ApplyChangeSetCursor(root: "/workspace", generation: "g1", sequence: 5),
            changes: [ApplyChangeSetChangeResult(
                changeID: "c1", afterSHA256: String(repeating: "a", count: 64),
                kind: "write", beforePath: "one.txt", afterPath: "one.txt",
                beforeIdentity: "dev:1", afterIdentity: "dev:2",
                beforeSHA256: String(repeating: "b", count: 64),
                beforeSizeBytes: 3, afterSizeBytes: 4,
                beforeMetadata: ApplyChangeSetMetadata(mode: 0o644),
                afterMetadata: ApplyChangeSetMetadata(mode: 0o644), result: "applied"
            )],
            changedPaths: ["one.txt"],
            transactionCursorAdvanced: true,
            diffArtifact: ApplyChangeSetArtifact(
                handle: "art_1", sha256: String(repeating: "c", count: 64), sizeBytes: 123,
                expiresAt: Date(timeIntervalSince1970: 1_800_000_000)
            ),
            summary: ApplyChangeSetSummary(
                createCount: 0, writeCount: 1, deleteCount: 0, renameCount: 0,
                beforeBytes: 3, afterBytes: 4
            ),
            diffPreview: "preview", hasMore: true, returnedDiffBytes: 7, omittedDiffBytes: 116
        )
        let wire = try XCTUnwrap(MCPServer().applyChangeSetJSON(result).objectValue)
        XCTAssertEqual(wire["schemaVersion"], .string("aishell.apply-change-set.v1"))
        XCTAssertEqual(wire["transaction_id"], .string("tx-1"))
        XCTAssertNil(wire["transactionID"])
        XCTAssertEqual(wire["returned_diff_bytes"], .number(7))
        XCTAssertEqual(wire["diff_artifact"]?.objectValue?["handle"], .string("art_1"))
        XCTAssertEqual(wire["changes"]?.arrayValue?.first?.objectValue?["before_path"], .string("one.txt"))
    }
}
