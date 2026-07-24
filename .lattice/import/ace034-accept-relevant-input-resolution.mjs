import { createHash } from "node:crypto";
import fs from "node:fs";
import {
  accept,
  importWorkerReport,
  taskFinalizeRecord,
} from "/Users/kite/Developer/dotagents/lib/orchestrate/control-record.mjs";

const cwd = "/Users/kite/Developer/aishell";
const control_id = "aishell-capability-expansion-20260721";
const actor_id = "bell-root-20260722-ace034-seams";
const worker_run_id = "ace034-relevant-input-resolution-writer-run";
const report = JSON.parse(fs.readFileSync(
  `${cwd}/.lattice/import/delegation/${worker_run_id}/worker-report.json`,
  "utf8",
));

let result = await importWorkerReport({
  cwd,
  control_id,
  actor_id,
  expected_revision: 86,
  worker_run_id,
  report,
});

const verification = "親再検証: RunCheckResolution 8/8、ProjectProfile 19/19、WorkspaceStateRuntime 34/34、git diff --check成功";
const evidence = {
  type: "command",
  ref: "parent-focused-verification:ace034-relevant-input-resolution",
  digest: createHash("sha256").update(verification).digest("hex"),
  observed_at: "2026-07-22T05:45:22.000Z",
};
result = await accept({
  cwd,
  control_id,
  actor_id,
  expected_revision: result.revision,
  worker_run_id,
  result_digest: report.result_digest,
  verification_evidence: [evidence],
  decision_note: verification,
  decided_by: actor_id,
});
result = await taskFinalizeRecord({
  cwd,
  control_id,
  actor_id,
  expected_revision: result.revision,
  task_id: "ace034-relevant-input-resolution",
  finalization_ref: "docs/adr/0019-freshness-cache-final-contract.md",
  recorded_by: actor_id,
});
process.stdout.write(`${JSON.stringify({ revision: result.revision })}\n`);
