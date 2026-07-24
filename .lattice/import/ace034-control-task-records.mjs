import { taskRecord } from "/Users/kite/Developer/dotagents/lib/orchestrate/control-record.mjs";

const cwd = process.cwd();
const control_id = "aishell-capability-expansion-20260721";
const actor_id = "bell-root-20260722-ace034-seams";
const common = {
  classification: "A",
  effect: "write",
  doc_ref: "docs/development-efficiency-plan.md",
  role: "implementer",
  lane: "behavior-change",
  depends_on: [],
  required_capabilities: ["workspace.read", "workspace.write", "report.structured"],
  isolation: "dedicated-worktree",
  context_policy: {
    share_objective: true,
    share_current_candidate: false,
    share_existing_findings: true,
    share_failed_approaches: true,
    share_test_results: true,
  },
  approval: null,
  alternative_group: null,
};

const tasks = [
  {
    task_id: "ace034-public-resolution-primitives",
    title: "public run_checkがcaller捏造なしでprofile・focused selectionをexact解決するprimitiveを追加する",
    validation: ["swift test --filter RunCheckInvocationPlanTests", "swift test --filter FocusedCheckServiceTests", "swift test --filter ProjectProfileServiceTests", "git diff --check"],
    non_goals: ["DevelopmentRuntimeService・MCP wire・cache serviceを変更しない", "担当6 file以外を変更しない", "commit・push・Lattice/Control更新をしない"],
    known_traps: ["profile selection digestをcaller supplied hashとして信用しない", "focused setの保存receiptをcurrent profile/catalog照合なしで返さない", "requested/planned順序を並べ替えない", "start実装を先取りしない"],
    read_scope: [
      { kind: "file", path: "docs/adr/0018-run-check-invocation-plan-contract.md" },
      { kind: "file", path: "docs/adr/0020-focused-check-final-contract.md" },
      { kind: "file", path: "Sources/AIShellCore/RunCheckResolutionService.swift" },
      { kind: "file", path: "Sources/AIShellCore/DevelopmentRuntimeService.swift" },
      { kind: "file", path: "Sources/AIShellCore/ChangeImpactService.swift" },
    ],
    write_scope: [
      { kind: "file", path: "Sources/AIShellCore/RunCheckInvocationPlan.swift" },
      { kind: "file", path: "Tests/AIShellCoreTests/RunCheckInvocationPlanTests.swift" },
      { kind: "file", path: "Sources/AIShellCore/FocusedCheckService.swift" },
      { kind: "file", path: "Tests/AIShellCoreTests/FocusedCheckServiceTests.swift" },
      { kind: "file", path: "Sources/AIShellCore/ProjectProfileService.swift" },
      { kind: "file", path: "Tests/AIShellCoreTests/ProjectProfileServiceTests.swift" },
    ],
  },
  {
    task_id: "ace034-mcp-request-adapter",
    title: "run_check v1/v2とchange_impactのclosed wireを意味requestへ変換するMCP adapterを追加する",
    validation: ["swift test --filter MCPRunCheckAdapterTests", "swift test --filter MCPRunCheckV2SchemaTests", "git diff --check"],
    non_goals: ["MCPServer・AIShellCore・tool schemaを変更しない", "担当2新規file以外を変更しない", "service呼出し・commit・push・Lattice/Control更新をしない"],
    known_traps: ["schemaだけをoracleにせずruntimeでもunknown fieldとv1/v2混在を拒否する", "profile selectionへcaller digestを要求しない", "focused set digestとselection digestを落とさない", "change_impact continuationとinitial requestを混在させない"],
    read_scope: [
      { kind: "file", path: "Sources/AIShellMCP/MCPTypes.swift" },
      { kind: "file", path: "Sources/AIShellMCP/MCPServer.swift" },
      { kind: "file", path: "Sources/AIShellCore/RunCheckInvocationPlan.swift" },
      { kind: "file", path: "Sources/AIShellCore/ChangeImpactService.swift" },
      { kind: "file", path: "Tests/AIShellMCPTests/MCPRunCheckV2SchemaTests.swift" },
    ],
    write_scope: [
      { kind: "file", path: "Sources/AIShellMCP/MCPRunCheckAdapter.swift" },
      { kind: "file", path: "Tests/AIShellMCPTests/MCPRunCheckAdapterTests.swift" },
    ],
  },
];

let revision = 89;
for (const task of tasks) {
  const result = await taskRecord({ cwd, control_id, actor_id, expected_revision: revision, task: { ...common, ...task } });
  revision = result.revision;
}
console.log(JSON.stringify({ revision }));
