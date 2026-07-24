import { createHash } from "node:crypto";
import { reservePlacement } from "/Users/kite/Developer/dotagents/lib/orchestrate/control-record.mjs";

const cwd = process.cwd();
const control_id = "aishell-capability-expansion-20260721";
const actor_id = "bell-root-20260722-ace034-seams";
const registry_observation_id = "codex-native-implementer-routing-20260722-ace034-public-wave";
const specs = [
  ["ace034-public-resolution-primitives", "ace034-public-primitives-writer-run", "ace034-public-primitives-assignment", "/Users/kite/Developer/aishell-worktrees/ace034-public-primitives", "/root/ace034_public_primitives_writer", "ace034-public-primitives"],
  ["ace034-mcp-request-adapter", "ace034-mcp-adapter-writer-run", "ace034-mcp-adapter-assignment", "/Users/kite/Developer/aishell-worktrees/ace034-mcp-adapter", "/root/ace034_mcp_adapter_writer", "ace034-mcp-adapter"],
];

let revision = 91;
for (const [task_id, candidate_id, assignment_id, workspace_cwd, agent_path, family] of specs) {
  const input_digest = createHash("sha256").update(`${task_id}:${family}:b191f7e`).digest("hex");
  const candidate = {
    candidate_id,
    registry_observation_id,
    assignment_id,
    workspace_cwd,
    workspace_binding: "fixed",
    write_mode: "direct",
    operation_digest: null,
    budget_reservation: { wall_time_seconds: 5400, cost_microusd: 3000000 },
    lineage: {
      parent_worker_run_id: null,
      root_assignment_id: assignment_id,
      provider: "openai",
      model: "gpt-5.6-terra",
      prompt_family: "implementation-v1",
      independence_group: family,
      context_policy: {
        share_objective: true,
        share_current_candidate: false,
        share_existing_findings: true,
        share_failed_approaches: true,
        share_test_results: true,
      },
      input_digest,
      approach_family_ref: `${family}-v1`,
      shared_artifact_ids: [],
    },
    fallback: null,
    executor_handle: { agent_path },
  };
  const result = await reservePlacement({ cwd, control_id, actor_id, expected_revision: revision, task_id, candidate, review_decision: null });
  revision = result.revision;
}
console.log(JSON.stringify({ revision }));
