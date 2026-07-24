import { taskFinalizeRecord } from "/Users/kite/Developer/dotagents/lib/orchestrate/control-record.mjs";

const cwd = "/Users/kite/Developer/aishell";
const control_id = "aishell-capability-expansion-20260721";
const actor_id = "bell-root-20260722-ace034-seams";
const result = await taskFinalizeRecord({
  cwd,
  control_id,
  actor_id,
  expected_revision: 126,
  task_id: "ace034-public-runtime-wire-integration",
  finalization_ref: "docs/adr/0018-run-check-invocation-plan-contract.md",
  recorded_by: actor_id,
});
process.stdout.write(`${JSON.stringify({ revision: result.revision })}\n`);
