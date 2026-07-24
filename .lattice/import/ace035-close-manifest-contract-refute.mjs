import { createHash } from 'node:crypto';
import {
  accept,
  observeWorker,
  taskFinalizeRecord,
} from '/Users/kite/Developer/dotagents/lib/orchestrate/control-record.mjs';

const cwd = '/Users/kite/Developer/aishell';
const control_id = 'aishell-capability-expansion-20260721';
const actor_id = 'bell-root-20260722-ace035-manifest-contract';
const worker_run_id = 'ace035-manifest-contract-refuter-run';
const verdict = '敵対的反証完了: 確実なP0–P2残存なし。ProjectProfileServiceTests 23/23、DevelopmentRuntimeServiceTests 3/3、代表runner 54試行valid。';
const result_digest = createHash('sha256').update(verdict).digest('hex');
const observed_at = new Date().toISOString();
const resultEvidence = {
  type: 'executor-receipt',
  ref: 'agents.final:/root/ace035_manifest_contract_refuter',
  digest: result_digest,
  observed_at,
};

let result = await observeWorker({
  cwd, control_id, actor_id, expected_revision: 158, worker_run_id,
  observation: {
    state: 'completed', source: 'codex-native', observed_version: 'gpt-5.6-sol high',
    observed_at, raw_state: 'completed clean',
    result: { result_digest, evidence: [resultEvidence] },
  },
});

const verification = '親検証: focused Swift/Node testとdiffを確認し、manifest closed contractの残存P0–P2なしを受理。';
result = await accept({
  cwd, control_id, actor_id, expected_revision: result.revision, worker_run_id, result_digest,
  verification_evidence: [{
    type: 'command', ref: 'parent-focused-verification:ace035-manifest-contract',
    digest: createHash('sha256').update(verification).digest('hex'), observed_at,
  }],
  decision_note: verification, decided_by: actor_id,
});

result = await taskFinalizeRecord({
  cwd, control_id, actor_id, expected_revision: result.revision,
  task_id: 'ace035-manifest-contract-refutation',
  finalization_ref: 'docs/adr/0009-project-profile-contract.md', recorded_by: actor_id,
});

process.stdout.write(`${JSON.stringify({ revision: result.revision, result_digest })}\n`);
