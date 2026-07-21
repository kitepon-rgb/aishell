import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  canonicalizeTodoArtifact,
  digestTodoArtifact,
  todoSelfDigest,
  validateTodoPlan,
} from '/opt/homebrew/lib/node_modules/@quolu/lattice/src/todo-contracts.mjs';
import {
  phaseTodoRevisionPlanVersion,
  validatePhaseTodoRevision,
} from '/opt/homebrew/lib/node_modules/@quolu/lattice/src/todo-revision.mjs';

const freshRoot = process.argv[2];
if (freshRoot === undefined || !path.isAbsolute(freshRoot)) {
  throw new Error('usage: node build-phase-dag-revision.mjs <fresh-clone-root>');
}

const latticeRoot = new URL('../', import.meta.url);
const repoRoot = path.resolve(new URL('../../', import.meta.url).pathname);
const manifest = JSON.parse(fs.readFileSync(new URL('todo/manifest.json', latticeRoot)));
const member = manifest.members.find(({ plan_key: planKey }) => planKey === 'aishell-capability-expansion');
if (member === undefined) throw new Error('active plan missing');
const currentDir = new URL(`todo/plans/aishell-capability-expansion/${member.active_plan_version}/`, latticeRoot);
const currentPlan = JSON.parse(fs.readFileSync(new URL('plan.json', currentDir)));
const currentSnapshot = JSON.parse(fs.readFileSync(new URL('snapshot.json', currentDir)));

function runJson(executable, args, cwd) {
  const result = spawnSync(executable, args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`${executable} ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
  }
  return JSON.parse(result.stdout);
}

function runText(executable, args, cwd) {
  const result = spawnSync(executable, args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`${executable} ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
  }
  return result.stdout.trim();
}

const sourceHead = runText('git', ['rev-parse', 'HEAD'], freshRoot);
const expectedHead = currentPlan.tasks.find(({ compile_binding: binding }) => binding !== null)
  ?.compile_binding.base_sha;
if (expectedHead === undefined || sourceHead !== expectedHead) {
  throw new Error(`fresh clone HEAD mismatch: ${sourceHead} != ${expectedHead}`);
}

const sensorReceipt = runJson('lattice', ['sensor', 'sync', '.', '--json'], freshRoot);
if (sensorReceipt.provider !== 'lattice' || sensorReceipt.sensor_owner !== 'lattice'
  || sensorReceipt.status !== 'ok') throw new Error('fresh Lattice sensor sync failed identity check');

const requests = [
  '.lattice/import/aishell-parallel-wave-request.json',
  '.lattice/import/aishell-parallel-wave-b-request.json',
];
const compileResults = requests.map((request) => runJson(
  'lattice', ['plan', 'compile', '--request', path.join(repoRoot, request)], freshRoot,
));
for (const result of compileResults) {
  if (result.schema !== 'lattice.plan_compile_result.v1'
    || result.plan.base_sha !== sourceHead || result.plan.conflicts.length !== 0
    || Object.values(result.manifests).some((item) => item.unknowns.length !== 0
      || item.graph_evidence.some(({ status }) => status !== 'ready'))) {
    throw new Error('fresh Lattice compile did not satisfy fail-closed acceptance');
  }
}

const evidence = [
  ['evidence/aishell-lattice-sensor-sync-20260721.json', sensorReceipt],
  ['evidence/aishell-lattice-sensor-wave-a-plan.json', compileResults[0]],
  ['evidence/aishell-lattice-sensor-wave-b-plan.json', compileResults[1]],
];
for (const [ref, value] of evidence) {
  const output = new URL(ref, latticeRoot);
  const bytes = `${canonicalizeTodoArtifact(value)}\n`;
  if (fs.existsSync(output)) {
    if (fs.readFileSync(output, 'utf8') !== bytes) throw new Error(`evidence drift: ${ref}`);
  } else {
    fs.writeFileSync(output, bytes, { flag: 'wx' });
  }
}

const bindings = new Map();
for (const result of compileResults) {
  for (const { todo_id: taskId } of result.plan.nodes) {
    bindings.set(taskId, {
      base_sha: result.plan.base_sha,
      boundary_manifest_digest: result.manifests[taskId].manifest_digest,
      compiled_plan_digest: result.plan.plan_digest,
      topology_digest: result.graph_digest,
    });
  }
}
const tasks = currentPlan.tasks.map((task) => ({
  ...task,
  compile_binding: bindings.get(task.task_id) ?? null,
}));
const phaseDefinition = [
  ['phase-0', '再baseline・測定契約・公開surface固定', []],
  ['phase-1', '永続workspace state', ['phase-0']],
  ['phase-2', '高頻度context統合', ['phase-0']],
  ['phase-3', 'freshness cache・変更影響', ['phase-0']],
  ['phase-4', '非同期process・artifact', ['phase-0']],
  ['phase-5', 'transaction付き編集loop', ['phase-0']],
  ['phase-6', 'adapter・semantic・worktree統合', [
    'phase-1', 'phase-2', 'phase-3', 'phase-4', 'phase-5',
  ]],
  ['phase-7', 'product gate・知識還流', ['phase-6']],
];
const phases = phaseDefinition.map(([phaseId, title, predecessorPhaseIds]) => ({
  gate_policy: 'dotagents-heavy-v1',
  phase_id: phaseId,
  predecessor_phase_ids: predecessorPhaseIds,
  required_evidence_slots: ['critic-decision', 'full-regression', 'maintenance-wave'],
  title,
}));
const predecessor = {
  journal_head_digest: currentSnapshot.journal_head_digest,
  plan_digest: currentPlan.plan_digest,
  plan_version: currentPlan.plan_version,
};
const taskMigration = tasks.map(({ task_id: taskId }) => ({
  from_task_id: taskId,
  state_policy: bindings.has(taskId) ? 'reset_pending' : 'carry',
  to_task_id: taskId,
}));
const phaseMigration = phases.map(({ phase_id: phaseId }) => ({
  from_phase_id: phaseId, state_policy: 'reset', to_phase_id: phaseId,
}));
const desiredSeed = {
  hard_dependencies: currentPlan.hard_dependencies,
  joins: currentPlan.joins,
  phases,
  plan_key: currentPlan.plan_key,
  predecessor_plan_digest: currentPlan.plan_digest,
  project_id: currentPlan.project_id,
  schema: 'lattice.todo_plan.v4',
  tasks,
};
const planVersion = phaseTodoRevisionPlanVersion({
  projectId: currentPlan.project_id,
  planKey: currentPlan.plan_key,
  predecessor,
  desiredPlan: desiredSeed,
  taskMigration,
  phaseMigration,
});
const topology = {
  hard_dependencies: currentPlan.hard_dependencies,
  joins: currentPlan.joins,
  phases,
  plan_key: currentPlan.plan_key,
  plan_version: planVersion,
  project_id: currentPlan.project_id,
  tasks,
};
const desiredPlan = {
  ...desiredSeed,
  plan_digest: '',
  plan_version: planVersion,
  topology_digest: digestTodoArtifact(topology),
};
desiredPlan.plan_digest = todoSelfDigest(desiredPlan, 'plan_digest');
const revision = {
  desired_plan: desiredPlan,
  phase_migration: phaseMigration,
  plan_key: currentPlan.plan_key,
  predecessor,
  project_id: currentPlan.project_id,
  revision_digest: '',
  schema: 'lattice.phase_todo_revision.v1',
  task_migration: taskMigration,
};
revision.revision_digest = todoSelfDigest(revision, 'revision_digest');
if (!validateTodoPlan(desiredPlan) || !validatePhaseTodoRevision(revision)) {
  throw new Error('generated Phase DAG revision failed validation');
}
const output = new URL('import/aishell-phase-dag-revision-v2.json', latticeRoot);
fs.writeFileSync(output, `${canonicalizeTodoArtifact(revision)}\n`, { flag: 'wx' });
process.stdout.write(`${JSON.stringify({
  schema: 'aishell.phase_dag_revision_build.v1',
  source_head: sourceHead,
  predecessor_plan_version: currentPlan.plan_version,
  desired_plan_version: planVersion,
  fresh_binding_count: bindings.size,
  phase_predecessors: Object.fromEntries(phases.map((phase) => [
    phase.phase_id, phase.predecessor_phase_ids,
  ])),
})}\n`);
