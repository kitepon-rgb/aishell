import { createHash } from 'node:crypto';
import fs from 'node:fs';
import {
  accept,
  importWorkerReport,
  taskFinalizeRecord,
} from '/Users/kite/Developer/dotagents/lib/orchestrate/control-record.mjs';

const cwd = '/Users/kite/Developer/aishell';
const control_id = 'aishell-capability-expansion-20260721';
const actor_id = 'bell-root-20260722-ace035-provider-wire';
const worker_run_id = 'ace035-provider-wire-refuter-run';
const report = JSON.parse(fs.readFileSync(`${cwd}/.lattice/import/delegation/${worker_run_id}/worker-report.json`, 'utf8'));

let result = await importWorkerReport({
  cwd, control_id, actor_id, expected_revision: 150, worker_run_id, report,
});

const verification = '親再検証: commit cfd9621、Phase 3 Node focused test 6/6、3ファイルnode --check、git diff --check成功。追加P0-P2なし。';
const observed_at = new Date().toISOString();
const evidence = {
  type: 'command',
  ref: 'parent-focused-verification:ace035-provider-wire-refutation:cfd9621',
  digest: createHash('sha256').update(verification).digest('hex'),
  observed_at,
};

result = await accept({
  cwd, control_id, actor_id, expected_revision: result.revision,
  worker_run_id, result_digest: report.result_digest,
  verification_evidence: [evidence], decision_note: verification, decided_by: actor_id,
});

result = await taskFinalizeRecord({
  cwd, control_id, actor_id, expected_revision: result.revision,
  task_id: 'ace035-provider-wire-refutation',
  finalization_ref: 'docs/adr/0018-run-check-invocation-plan-contract.md',
  recorded_by: actor_id,
});

process.stdout.write(`${JSON.stringify({ revision: result.revision })}\n`);
