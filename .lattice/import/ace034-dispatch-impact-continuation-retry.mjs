import { createHash } from "node:crypto";
import { observeWorker } from "/Users/kite/Developer/dotagents/lib/orchestrate/control-record.mjs";

const ref = "agents.followup_task:/root/ace034_impact_continuation_writer#ace034-impact-continuation-retry-run";
const observed_at = "2026-07-22T06:13:00.000Z";
const result = await observeWorker({
  cwd: "/Users/kite/Developer/aishell",
  control_id: "aishell-capability-expansion-20260721",
  actor_id: "bell-root-20260722-ace034-seams",
  expected_revision: 117,
  worker_run_id: "ace034-impact-continuation-retry-run",
  observation: {
    state: "dispatched",
    source: "codex-native",
    observed_version: "gpt-5.6-terra",
    observed_at,
    raw_state: "native implementer follow-up dispatched to clean retry workspace",
    executor_handle: { agent_path: "/root/ace034_impact_continuation_writer" },
    dispatch_evidence: [{
      type: "executor-receipt",
      ref,
      digest: createHash("sha256").update(ref).digest("hex"),
      observed_at,
    }],
  },
});
process.stdout.write(`${JSON.stringify({ revision: result.revision })}\n`);
