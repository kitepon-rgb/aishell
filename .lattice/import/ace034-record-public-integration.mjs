import { taskRecord } from "/Users/kite/Developer/dotagents/lib/orchestrate/control-record.mjs";

const cwd = "/Users/kite/Developer/aishell";
const control_id = "aishell-capability-expansion-20260721";
const actor_id = "bell-root-20260722-ace034-seams";
const result = await taskRecord({
  cwd,
  control_id,
  actor_id,
  expected_revision: 125,
  task: {
    task_id: "ace034-public-runtime-wire-integration",
    title: "run_checkとchange_impactを共有runtimeへ結線し公開wire契約を閉じる",
    classification: "F",
    effect: "write",
    doc_ref: "docs/development-efficiency-plan.md",
    role: "implementer",
    lane: "behavior-change",
    depends_on: [
      "ace034-public-resolution-primitives",
      "ace034-mcp-request-adapter",
      "ace034-profile-service-sharing",
      "ace034-impact-continuation-seam",
    ],
    validation: [
      "swift test --filter MCPRunCheckV2WireTests",
      "swift test --filter MCPRunCheckAdapterTests",
      "swift test --filter MCPRunCheckV2SchemaTests",
      "swift test --filter RunCheckPipelineIntegrationTests",
      "swift test --filter ChangeImpactServiceTests",
      "swift test --filter DevelopmentRuntimeServiceTests",
      "git diff --check",
    ],
    non_goals: [
      "非同期startを先取りしない",
      "legacy v1を削除・縮小しない",
      "Control全体をACE-034だけでfinalizeしない",
    ],
    known_traps: [
      "公開schemaとruntime validationを不一致にしない",
      "profile・cursor driftをgeneric errorへ漏らさない",
      "caller supplied selection hashを新規prepare経路で要求しない",
      "silent cache・selection fallbackを行わない",
    ],
    read_scope: [
      { kind: "directory", path: "Sources/AIShellCore" },
      { kind: "directory", path: "Sources/AIShellMCP" },
      { kind: "directory", path: "Tests" },
      { kind: "directory", path: "docs/adr" },
    ],
    write_scope: [
      { kind: "file", path: "Sources/AIShellCore/CheckFreshnessCache.swift" },
      { kind: "file", path: "Sources/AIShellCore/DevelopmentRuntimeService.swift" },
      { kind: "file", path: "Sources/AIShellMCP/MCPRunCheckAdapter.swift" },
      { kind: "file", path: "Sources/AIShellMCP/MCPServer.swift" },
      { kind: "file", path: "Sources/AIShellMCP/MCPTypes.swift" },
      { kind: "file", path: "Tests/AIShellCoreTests/DevelopmentRuntimeServiceTests.swift" },
      { kind: "file", path: "Tests/AIShellMCPTests/MCPRunCheckAdapterTests.swift" },
      { kind: "file", path: "Tests/AIShellMCPTests/MCPRunCheckV2SchemaTests.swift" },
      { kind: "file", path: "Tests/AIShellMCPTests/MCPRunCheckV2WireTests.swift" },
      { kind: "file", path: "docs/adr/0003-expanded-development-surface-contract.md" },
      { kind: "file", path: "docs/adr/0018-run-check-invocation-plan-contract.md" },
      { kind: "file", path: "docs/adr/0020-focused-check-final-contract.md" },
      { kind: "file", path: "docs/development-efficiency-plan.md" },
    ],
    required_capabilities: ["workspace.read", "workspace.write", "report.structured"],
    isolation: "none",
    context_policy: {
      share_objective: true,
      share_current_candidate: true,
      share_existing_findings: true,
      share_failed_approaches: true,
      share_test_results: true,
    },
    approval: null,
    alternative_group: null,
  },
});
process.stdout.write(`${JSON.stringify({ revision: result.revision })}\n`);
