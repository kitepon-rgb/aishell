import { createHash } from "node:crypto";
import {
  taskRecord,
  reservePlacement,
  admitWorker,
} from "/Users/kite/Developer/dotagents/lib/orchestrate/control-record.mjs";

const cwd = "/Users/kite/Developer/aishell";
const control_id = "aishell-capability-expansion-20260721";
const actor_id = "bell-root-20260722-ace034-seams";
const registry_observation_id = "codex-native-implementer-routing-20260722-ace034-public-wave";
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
    task_id: "ace034-impact-continuation-seam",
    title: "change_impactのopaque continuationをanalyze/recommend共通入口からexact再開する",
    validation: ["swift test --filter ChangeImpactServiceTests", "git diff --check"],
    non_goals: ["MCPServer・adapter・他Core serviceを変更しない", "担当2 file以外を変更しない", "commit・push・Lattice/Control更新をしない"],
    known_traps: ["analyze失敗後recommendへfallbackしない", "token prefixだけをauthorityにしない", "同一tokenを二重消費しない", "既存analyze/recommend API互換を壊さない"],
    read_scope: [
      { kind: "file", path: "Sources/AIShellMCP/MCPRunCheckAdapter.swift" },
      { kind: "file", path: "docs/adr/0003-expanded-development-surface-contract.md" },
    ],
    write_scope: [
      { kind: "file", path: "Sources/AIShellCore/ChangeImpactService.swift" },
      { kind: "file", path: "Tests/AIShellCoreTests/ChangeImpactServiceTests.swift" },
    ],
    worker_run_id: "ace034-impact-continuation-writer-run",
    assignment_id: "ace034-impact-continuation-assignment",
    workspace_cwd: "/Users/kite/Developer/aishell-worktrees/ace034-impact-continuation",
    agent_path: "/root/ace034_impact_continuation_writer",
    family: "ace034-impact-continuation",
  },
  {
    task_id: "ace034-profile-service-sharing",
    title: "ContextCompilerへProjectProfileServiceを注入し公開経路で単一authorityを共有できるようにする",
    validation: ["swift test --filter ContextCompilerServiceTests", "git diff --check"],
    non_goals: ["DevelopmentRuntimeService・MCPServer・ProjectProfileServiceを変更しない", "担当2 file以外を変更しない", "commit・push・Lattice/Control更新をしない"],
    known_traps: ["既存initializer呼出しを壊さない", "workspace runtimeと異なるprofile authorityを暗黙生成しない", "公開挙動やprojection順序を変えない"],
    read_scope: [
      { kind: "file", path: "Sources/AIShellCore/DevelopmentRuntimeService.swift" },
      { kind: "file", path: "Sources/AIShellCore/ProjectProfileService.swift" },
      { kind: "file", path: "docs/adr/0018-run-check-invocation-plan-contract.md" },
    ],
    write_scope: [
      { kind: "file", path: "Sources/AIShellCore/ContextCompilerService.swift" },
      { kind: "file", path: "Tests/AIShellCoreTests/ContextCompilerServiceTests.swift" },
    ],
    worker_run_id: "ace034-profile-sharing-writer-run",
    assignment_id: "ace034-profile-sharing-assignment",
    workspace_cwd: "/Users/kite/Developer/aishell-worktrees/ace034-profile-service-sharing",
    agent_path: "/root/ace034_profile_sharing_writer",
    family: "ace034-profile-service-sharing",
  },
];

let revision = 103;
for (const entry of tasks) {
  const { worker_run_id, assignment_id, workspace_cwd, agent_path, family, ...task } = entry;
  const result = await taskRecord({ cwd, control_id, actor_id, expected_revision: revision, task: { ...common, ...task } });
  revision = result.revision;
}
for (const entry of tasks) {
  const input_digest = createHash("sha256").update(`${entry.task_id}:${entry.family}:658c2ac`).digest("hex");
  const candidate = {
    candidate_id: entry.worker_run_id,
    registry_observation_id,
    assignment_id: entry.assignment_id,
    workspace_cwd: entry.workspace_cwd,
    workspace_binding: "fixed",
    write_mode: "direct",
    operation_digest: null,
    budget_reservation: { wall_time_seconds: 5400, cost_microusd: 3000000 },
    lineage: {
      parent_worker_run_id: null,
      root_assignment_id: entry.assignment_id,
      provider: "openai",
      model: "gpt-5.6-terra",
      prompt_family: "implementation-v1",
      independence_group: entry.family,
      context_policy: common.context_policy,
      input_digest,
      approach_family_ref: `${entry.family}-v1`,
      shared_artifact_ids: [],
    },
    fallback: null,
    executor_handle: { agent_path: entry.agent_path },
  };
  const result = await reservePlacement({ cwd, control_id, actor_id, expected_revision: revision, task_id: entry.task_id, candidate, review_decision: null });
  revision = result.revision;
}
for (const entry of tasks) {
  const result = await admitWorker({ cwd, control_id, actor_id, expected_revision: revision, worker_run_id: entry.worker_run_id });
  revision = result.revision;
}

process.stdout.write(`${JSON.stringify({ revision })}\n`);
