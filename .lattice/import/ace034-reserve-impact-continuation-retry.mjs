import { createHash } from "node:crypto";
import { reservePlacement, admitWorker } from "/Users/kite/Developer/dotagents/lib/orchestrate/control-record.mjs";

const cwd = "/Users/kite/Developer/aishell";
const control_id = "aishell-capability-expansion-20260721";
const actor_id = "bell-root-20260722-ace034-seams";
const worker_run_id = "ace034-impact-continuation-retry-run";
const assignment_id = "ace034-impact-continuation-retry-assignment";
const context_policy = {
  share_objective: true,
  share_current_candidate: false,
  share_existing_findings: true,
  share_failed_approaches: true,
  share_test_results: true,
};
let result = await reservePlacement({
  cwd,
  control_id,
  actor_id,
  expected_revision: 115,
  task_id: "ace034-impact-continuation-seam",
  candidate: {
    candidate_id: worker_run_id,
    registry_observation_id: "codex-native-implementer-routing-20260722-ace034-public-wave",
    assignment_id,
    workspace_cwd: "/Users/kite/Developer/aishell-worktrees/ace034-impact-continuation-retry",
    workspace_binding: "fixed",
    write_mode: "direct",
    operation_digest: null,
    budget_reservation: { wall_time_seconds: 1800, cost_microusd: 1000000 },
    lineage: {
      parent_worker_run_id: null,
      root_assignment_id: assignment_id,
      provider: "openai",
      model: "gpt-5.6-terra",
      prompt_family: "implementation-v1",
      independence_group: "ace034-impact-continuation-retry",
      context_policy,
      input_digest: createHash("sha256").update("ace034-impact-continuation-seam:retry:658c2ac").digest("hex"),
      approach_family_ref: "ace034-impact-continuation-v1",
      shared_artifact_ids: [],
    },
    fallback: null,
    executor_handle: { agent_path: "/root/ace034_impact_continuation_writer" },
  },
  review_decision: null,
});
result = await admitWorker({
  cwd, control_id, actor_id, expected_revision: result.revision, worker_run_id,
});
process.stdout.write(`${JSON.stringify({ revision: result.revision })}\n`);
