import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  admitWorker,
  delegationPacketForWorker,
  placementDryRun,
  registryObservationRecord,
  reservePlacement,
  taskRecord,
  workerReportSkeletonForWorker,
} from '/Users/kite/Developer/dotagents/lib/orchestrate/control-record.mjs';

const cwd = '/Users/kite/Developer/aishell';
const control_id = 'aishell-capability-expansion-20260721';
const actor_id = 'bell-root-20260722-ace035-provider-wire';
const observed_at = new Date().toISOString();
const expires_at = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
const evidenceRef = 'verify-codex-agent-routing:refuter:/root/ace035_wire_refuter';
const evidence = {
  type: 'executor-receipt', ref: evidenceRef,
  digest: createHash('sha256').update(evidenceRef).digest('hex'), observed_at,
};

let revision = 145;
({ revision } = await taskRecord({
  cwd, control_id, actor_id, expected_revision: revision,
  task: {
    task_id: 'ace035-provider-wire-refutation',
    title: 'provider SSE証拠とMCP original wire取得を敵対的に反証する',
    classification: 'F', effect: 'read', doc_ref: 'docs/evidence/2026-07-22-ace-035-phase3-harness-readiness.md',
    role: 'refuter', lane: 'behavior-change', depends_on: ['ace035-local-production-callbacks'],
    validation: [
      'node --test benchmarks/test-phase3-mcp-wire-tap.mjs benchmarks/test-phase3-local-callbacks.mjs benchmarks/test-phase3-codex-executor.mjs',
      'git diff --check',
    ],
    non_goals: ['ファイルを変更しない', '凍結fixtureを改訂しない', 'requested modelや再serializationを証拠として認めない'],
    known_traps: ['全target RUST_LOG=traceは秘密を含み得る', 'stdio tapは1 byteも変更しない', 'retained artifactをwire descriptorへ結合する'],
    read_scope: [
      { kind: 'directory', path: 'benchmarks' },
      { kind: 'file', path: 'docs/evidence/2026-07-22-ace-035-phase3-harness-readiness.md' },
      { kind: 'directory', path: 'rag' },
    ],
    write_scope: [],
    required_capabilities: ['workspace.read', 'report.structured'], isolation: 'none',
    context_policy: { share_objective: true, share_current_candidate: true, share_existing_findings: true, share_failed_approaches: true, share_test_results: true },
    approval: null, alternative_group: null,
  },
}));

const registry_observation_id = 'codex-native-refuter-routing-20260722-ace035-wire';
({ revision } = await registryObservationRecord({
  cwd, control_id, actor_id, expected_revision: revision,
  observation: {
    registry_observation_id,
    executor: { adapter_id: 'codex-native', contract_version: 'v1', instance_id: 'native-subagent', handle_schema_id: 'codex-native.agent-path.v1' },
    workflow_id: 'native-subagent',
    enabled: { value: 'true', evidence },
    workflow_capabilities: [
      { capability_id: 'report.structured', value: 'true', evidence },
      { capability_id: 'workspace.read', value: 'true', evidence },
    ],
    capacity: {
      admission: { value: 'true', evidence },
      hard_inflight_limit: { knowledge: 'known', value: 1, evidence },
      soft_inflight_limit: { knowledge: 'known', value: 1, evidence },
      observed_inflight: { knowledge: 'known', value: 0, evidence },
    },
    verification: { stage: 'execution-verified', observed_version: 'codex-cli 0.144.6 / gpt-5.6-sol high', observed_at, evidence },
    expires_at,
  },
}));

const candidate = {
  candidate_id: 'ace035-provider-wire-refuter-run', registry_observation_id,
  assignment_id: 'ace035-provider-wire-refuter-assignment',
  workspace_cwd: cwd, workspace_binding: 'fixed', write_mode: 'none', operation_digest: null,
  budget_reservation: { wall_time_seconds: 1800, cost_microusd: 1000000 },
  lineage: {
    parent_worker_run_id: null, root_assignment_id: 'ace035-provider-wire-refuter-assignment',
    provider: 'openai', model: 'gpt-5.6-sol', prompt_family: 'refutation-v1',
    independence_group: 'ace035-provider-wire-refutation',
    context_policy: { share_objective: true, share_current_candidate: true, share_existing_findings: true, share_failed_approaches: true, share_test_results: true },
    input_digest: createHash('sha256').update('ace035-provider-wire-refutation:current-diff').digest('hex'),
    approach_family_ref: 'ace035-provider-wire-refutation-v1', shared_artifact_ids: [],
  },
  fallback: null, executor_handle: { agent_path: '/root/ace035_wire_refuter' },
};

const dryRun = await placementDryRun({ cwd, control_id, task_id: 'ace035-provider-wire-refutation', evaluated_at: observed_at, candidates: [candidate] });
if (dryRun.candidates[0]?.eligibility !== 'eligible') throw new Error(`refuter placement is not eligible: ${JSON.stringify(dryRun)}`);
({ revision } = await reservePlacement({ cwd, control_id, actor_id, expected_revision: revision, task_id: 'ace035-provider-wire-refutation', candidate, review_decision: null }));
({ revision } = await admitWorker({ cwd, control_id, actor_id, expected_revision: revision, worker_run_id: candidate.candidate_id }));

const directory = path.join(cwd, '.lattice/import/delegation', candidate.candidate_id);
fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
fs.writeFileSync(path.join(directory, 'delegation-packet.json'), `${JSON.stringify(await delegationPacketForWorker({ cwd, control_id, worker_run_id: candidate.candidate_id }), null, 2)}\n`, { mode: 0o600 });
fs.writeFileSync(path.join(directory, 'worker-report-skeleton.json'), `${JSON.stringify(await workerReportSkeletonForWorker({ cwd, control_id, worker_run_id: candidate.candidate_id }), null, 2)}\n`, { mode: 0o600 });
process.stdout.write(`${JSON.stringify({ revision, packetDirectory: directory })}\n`);
