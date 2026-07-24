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

const completions = [
  {
    worker_run_id: "ace034-public-primitives-writer-run",
    task_id: "ace034-public-resolution-primitives",
    finalization_ref: "docs/adr/0018-run-check-invocation-plan-contract.md",
    verification: "親再検証: RunCheckInvocationPlanTests 8/8、FocusedCheckServiceTests 8/8、ProjectProfileServiceTests 19/19、git diff --check成功",
    observed_at: "2026-07-22T06:00:19.000Z",
  },
  {
    worker_run_id: "ace034-mcp-adapter-writer-run",
    task_id: "ace034-mcp-request-adapter",
    finalization_ref: "docs/adr/0003-expanded-development-surface-contract.md",
    verification: "親再検証: MCPRunCheckAdapterTests 4/4、MCPRunCheckV2SchemaTests 11/11、git diff --check成功",
    observed_at: "2026-07-22T06:00:19.000Z",
  },
];

let expected_revision = 97;
for (const completion of completions) {
  const raw = JSON.parse(fs.readFileSync(
    `${cwd}/.lattice/import/delegation/${completion.worker_run_id}/worker-report.json`,
    "utf8",
  ));
  const report = raw.report ?? raw;
  let result = await importWorkerReport({
    cwd,
    control_id,
    actor_id,
    expected_revision,
    worker_run_id: completion.worker_run_id,
    report,
  });
  const evidence = {
    type: "command",
    ref: `parent-focused-verification:${completion.task_id}`,
    digest: createHash("sha256").update(completion.verification).digest("hex"),
    observed_at: completion.observed_at,
  };
  result = await accept({
    cwd,
    control_id,
    actor_id,
    expected_revision: result.revision,
    worker_run_id: completion.worker_run_id,
    result_digest: report.result_digest,
    verification_evidence: [evidence],
    decision_note: completion.verification,
    decided_by: actor_id,
  });
  result = await taskFinalizeRecord({
    cwd,
    control_id,
    actor_id,
    expected_revision: result.revision,
    task_id: completion.task_id,
    finalization_ref: completion.finalization_ref,
    recorded_by: actor_id,
  });
  expected_revision = result.revision;
}

process.stdout.write(`${JSON.stringify({ revision: expected_revision })}\n`);
