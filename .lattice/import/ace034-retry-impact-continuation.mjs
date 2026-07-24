import { createHash } from "node:crypto";
import {
  observeWorker,
  reservePlacement,
  admitWorker,
} from "/Users/kite/Developer/dotagents/lib/orchestrate/control-record.mjs";

const cwd = "/Users/kite/Developer/aishell";
const control_id = "aishell-capability-expansion-20260721";
const actor_id = "bell-root-20260722-ace034-seams";
const observed_at = "2026-07-22T06:10:00.000Z";
const recovery = "親のcommit順序ミスによりworkspace fingerprintが変化。実装失敗ではなくclean retry workspaceへ移送する";
let result = await observeWorker({
  cwd,
  control_id,
  actor_id,
  expected_revision: 114,
  worker_run_id: "ace034-impact-continuation-writer-run",
  observation: {
    state: "cancelled",
    source: "codex-native",
    observed_version: "gpt-5.6-terra",
    observed_at,
    raw_state: recovery,
    executor_handle: { agent_path: "/root/ace034_impact_continuation_writer" },
    terminal_evidence: [{
      type: "executor-receipt",
      ref: "parent-recovery:ace034-impact-continuation-writer-run",
      digest: createHash("sha256").update(recovery).digest("hex"),
      observed_at,
    }],
  },
});

const worker_run_id = "ace034-impact-continuation-retry-run";
const assignment_id = "ace034-impact-continuation-retry-assignment";
const input_digest = createHash("sha256").update("ace034-impact-continuation-seam:retry:658c2ac").digest("hex");
result = await reservePlacement({
  cwd,
  control_id,
  actor_id,
  expected_revision: result.revision,
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
      context_policy: {
        share_objective: true,
        share_current_candidate: true,
        share_existing_findings: true,
        share_failed_approaches: true,
        share_test_results: true,
      },
      input_digest,
      approach_family_ref: "ace034-impact-continuation-v1",
      shared_artifact_ids: [],
    },
    fallback: null,
    executor_handle: { agent_path: "/root/ace034_impact_continuation_writer" },
  },
  review_decision: null,
});
result = await admitWorker({
  cwd,
  control_id,
  actor_id,
  expected_revision: result.revision,
  worker_run_id,
});
process.stdout.write(`${JSON.stringify({ revision: result.revision })}\n`);
