import { createHash } from "node:crypto";
import { observeWorker } from "/Users/kite/Developer/dotagents/lib/orchestrate/control-record.mjs";

const cwd = "/Users/kite/Developer/aishell";
const control_id = "aishell-capability-expansion-20260721";
const actor_id = "bell-root-20260722-ace034-seams";
const observed_at = "2026-07-22T05:50:07.000Z";
const specs = [
  ["ace034-public-primitives-writer-run", "/root/ace034_public_primitives_writer"],
  ["ace034-mcp-adapter-writer-run", "/root/ace034_mcp_adapter_writer"],
];
let revision = 95;
for (const [worker_run_id, agent_path] of specs) {
  const ref = `agents.followup_task:${agent_path}#${worker_run_id}`;
  const result = await observeWorker({
    cwd,
    control_id,
    actor_id,
    expected_revision: revision,
    worker_run_id,
    observation: {
      state: "dispatched",
      source: "codex-native",
      observed_version: "gpt-5.6-terra",
      observed_at,
      raw_state: "native subagent follow-up dispatched",
      executor_handle: { agent_path },
      dispatch_evidence: [{
        type: "executor-receipt",
        ref,
        digest: createHash("sha256").update(ref).digest("hex"),
        observed_at,
      }],
    },
  });
  revision = result.revision;
}
process.stdout.write(`${JSON.stringify({ revision })}\n`);
