import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  admitWorker, delegationPacketForWorker, observeWorker, placementDryRun, reservePlacement,
  taskRecord, workerReportSkeletonForWorker,
} from '/Users/kite/Developer/dotagents/lib/orchestrate/control-record.mjs';

const cwd = '/Users/kite/Developer/aishell';
const control_id = 'aishell-capability-expansion-20260721';
const actor_id = 'bell-root-20260722-provider-evidence-v3-fix';
const observed_at = new Date().toISOString();
let revision = 170;
const candidate = {
  candidate_id: 'ace035-provider-evidence-v3-fix-refuter-run',
  registry_observation_id: 'codex-native-refuter-routing-20260722-provider-evidence-v2',
  assignment_id: 'ace035-provider-evidence-v3-fix-refuter-assignment', workspace_cwd: cwd, workspace_binding: 'fixed', write_mode: 'none', operation_digest: null,
  budget_reservation: { wall_time_seconds: 1800, cost_microusd: 1000000 },
  lineage: { parent_worker_run_id: null, root_assignment_id: 'ace035-provider-evidence-v3-fix-refuter-assignment', provider: 'openai', model: 'gpt-5.6-sol', prompt_family: 'refutation-v1', independence_group: 'ace035-provider-evidence-v3-fix-refutation', context_policy: { share_objective: true, share_current_candidate: true, share_existing_findings: true, share_failed_approaches: true, share_test_results: true }, input_digest: createHash('sha256').update('ace035-provider-evidence-v3:fix-diff').digest('hex'), approach_family_ref: 'ace035-provider-evidence-v3-fix-refutation-v1', shared_artifact_ids: [] },
  fallback: null, executor_handle: { agent_path: '/root/ace035_provider_evidence_refuter' },
};
const dryRun = await placementDryRun({ cwd, control_id, task_id: 'ace035-provider-evidence-v3-fix-refutation', evaluated_at: observed_at, candidates: [candidate] });
if (dryRun.candidates[0]?.eligibility !== 'eligible') throw new Error(JSON.stringify(dryRun));
({ revision } = await reservePlacement({ cwd, control_id, actor_id, expected_revision: revision, task_id: 'ace035-provider-evidence-v3-fix-refutation', candidate, review_decision: null }));
({ revision } = await admitWorker({ cwd, control_id, actor_id, expected_revision: revision, worker_run_id: candidate.candidate_id }));
const directory = path.join(cwd, '.lattice/import/delegation', candidate.candidate_id);
fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
fs.writeFileSync(path.join(directory, 'delegation-packet.json'), `${JSON.stringify(await delegationPacketForWorker({ cwd, control_id, worker_run_id: candidate.candidate_id }), null, 2)}\n`, { mode: 0o600 });
fs.writeFileSync(path.join(directory, 'worker-report-skeleton.json'), `${JSON.stringify(await workerReportSkeletonForWorker({ cwd, control_id, worker_run_id: candidate.candidate_id }), null, 2)}\n`, { mode: 0o600 });
const receipt = 'codex-native:/root/ace035_provider_evidence_refuter:followup-v3-fix';
({ revision } = await observeWorker({ cwd, control_id, actor_id, expected_revision: revision, worker_run_id: candidate.candidate_id, observation: {
  state: 'dispatched', source: 'codex-native', observed_version: 'gpt-5.6-sol high', observed_at,
  raw_state: 'native refuter followup dispatched', executor_handle: candidate.executor_handle,
  dispatch_evidence: [{ type: 'executor-receipt', ref: receipt, digest: createHash('sha256').update(receipt).digest('hex'), observed_at }],
} }));
process.stdout.write(`${JSON.stringify({ revision, directory })}\n`);
