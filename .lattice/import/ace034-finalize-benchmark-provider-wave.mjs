import { taskFinalizeRecord } from "/Users/kite/Developer/dotagents/lib/orchestrate/control-record.mjs";

const cwd = "/Users/kite/Developer/aishell";
const control_id = "aishell-capability-expansion-20260721";
const actor_id = "bell-root-20260722-ace034-benchmark-adapter";
const finalization_ref = "docs/adr/0012-change-impact-contract.md";

let result = await taskFinalizeRecord({
  cwd,
  control_id,
  actor_id,
  expected_revision: 130,
  task_id: "ace034-benchmark-v1-production-v2-adapter",
  finalization_ref,
  recorded_by: actor_id,
});

result = await taskFinalizeRecord({
  cwd,
  control_id,
  actor_id,
  expected_revision: result.revision,
  task_id: "ace034-static-import-impact-provider",
  finalization_ref,
  recorded_by: actor_id,
});

result = await taskFinalizeRecord({
  cwd,
  control_id,
  actor_id,
  expected_revision: result.revision,
  task_id: "ace034-depfile-impact-provider",
  finalization_ref,
  recorded_by: actor_id,
});

process.stdout.write(`${JSON.stringify({ revision: result.revision })}\n`);
