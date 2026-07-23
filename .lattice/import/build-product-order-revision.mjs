import fs from 'node:fs';
import path from 'node:path';

import {
  canonicalizeTodoArtifact,
  digestTodoArtifact,
  todoSelfDigest,
} from '/Users/kite/Developer/Lattice/src/todo-contracts.mjs';
import { buildTodoPlan } from '/Users/kite/Developer/Lattice/src/todo-store.mjs';
import {
  phaseTodoRevisionPlanVersion,
  todoSourceInventoryDigest,
  validatePhaseTodoRevision,
} from '/Users/kite/Developer/Lattice/src/todo-revision.mjs';

const repoRoot = path.resolve(new URL('../../', import.meta.url).pathname);
const manifest = JSON.parse(fs.readFileSync(path.join(repoRoot, '.lattice/todo/manifest.json')));
const descriptor = manifest.members.find(({ plan_key: planKey }) =>
  planKey === 'aishell-capability-expansion');
if (descriptor === undefined) throw new Error('active plan missing');
const activeRoot = path.join(repoRoot, '.lattice/todo/plans', descriptor.plan_key,
  descriptor.active_plan_version);
const currentPlan = JSON.parse(fs.readFileSync(path.join(activeRoot, 'plan.json')));
const currentRevision = JSON.parse(fs.readFileSync(path.join(activeRoot, 'revision.json')));
const currentSnapshot = JSON.parse(fs.readFileSync(path.join(activeRoot, 'snapshot.json')));
if (currentPlan.schema !== 'lattice.todo_plan.v5'
  || currentRevision.schema !== 'lattice.phase_todo_revision.v3') {
  throw new Error('phase v3 predecessor required');
}

const projectId = currentPlan.project_id;
const planKey = currentPlan.plan_key;
const ref = (taskId) => ({ project_id: projectId, plan_key: planKey, task_id: taskId });
const edgeKey = ({ from, to }) => `${from.task_id}\0${to.task_id}`;
const removedEdges = new Set(['ace-071\0ace-072']);
const hardDependencies = currentPlan.hard_dependencies
  .filter((edge) => !removedEdges.has(edgeKey(edge)));
for (const [from, to] of [['ace-065', 'ace-072'], ['ace-073', 'ace-070']]) {
  hardDependencies.push({ from: ref(from), to: ref(to) });
}
hardDependencies.sort((left, right) => edgeKey(left).localeCompare(edgeKey(right), 'en'));

const archiveRef = '.lattice/todo/source-ledger/aishell-product-order-cutover-20260723.md';
const changedTitles = new Map([
  ['ace-070', '全製品工程の完了後、目的・規模・所要時間をオーナーへ説明し、明示了承を得た場合だけ3 arm代表ベンチを実行・集計する。'],
  ['ace-073', 'README、MCP instructions、RAG、release notes、公開schemaを同期し、commit、push、release、install、Control finalization証拠を残す。'],
]);
const changedTaskIds = [...changedTitles.keys()];
const predecessorInventory = new Map(currentRevision.source_inventory.active
  .map((entry) => [entry.task_id, entry]));
const sourceCutoverBatch = {
  batch_id: 'aishell-product-order-20260723',
  archive_ref: archiveRef,
  operations: changedTaskIds.map((taskId) => {
    const source = predecessorInventory.get(taskId);
    if (source === undefined) throw new Error(`source inventory missing: ${taskId}`);
    return {
      task_id: taskId,
      disposition: 'active',
      source_ref: source.source_ref,
      source_digest: source.source_digest,
      live_replacement: `- ${taskId.toUpperCase()}の工程状態はLattice正本へ移転済み。`,
    };
  }).sort((left, right) => left.source_ref.localeCompare(right.source_ref, 'en')),
  batch_digest: '',
};
sourceCutoverBatch.batch_digest = todoSelfDigest(sourceCutoverBatch, 'batch_digest');
const archivedRefByTask = new Map(sourceCutoverBatch.operations.map((operation, index) =>
  [operation.task_id, `${archiveRef}#L${index + 6}`]));

const tasks = currentPlan.tasks.map((task) => changedTitles.has(task.task_id) ? {
  ...task,
  title: changedTitles.get(task.task_id),
  narrative_ref: archivedRefByTask.get(task.task_id),
} : task);
const sourceInventory = {
  active: currentRevision.source_inventory.active.map((entry) =>
    archivedRefByTask.has(entry.task_id)
      ? { ...entry, source_ref: archivedRefByTask.get(entry.task_id) }
      : entry),
  excluded_tombstones: currentRevision.source_inventory.excluded_tombstones,
};

const resetTasks = new Set(['ace-070', 'ace-071', 'ace-072', 'ace-073']);
const runtimeTaskMigration = {
  schema: 'lattice.runtime_task_migration.v1',
  entries: currentPlan.tasks.map(({ task_id: taskId }) => ({
    predecessor_task_id: taskId,
    disposition: resetTasks.has(taskId) ? 'replace' : 'stay',
    successor_task_ids: [taskId],
    reason: resetTasks.has(taskId)
      ? 'オーナー裁定に従い製品完成と配布を先行し、ベンチマークを最後の明示了承事項へ移す'
      : '既存task identity、工程状態、証拠を意味変更なしで維持する',
    evidence_digests: [predecessorInventory.get(taskId).source_digest],
  })),
  migration_digest: '',
};
runtimeTaskMigration.migration_digest = todoSelfDigest(runtimeTaskMigration, 'migration_digest');
const taskMigration = currentPlan.tasks.map(({ task_id: taskId }) => ({
  from_task_id: taskId,
  to_task_id: taskId,
  state_policy: resetTasks.has(taskId) ? 'reset_pending' : 'carry',
}));
const phaseMigration = currentPlan.phases.map(({ phase_id: phaseId }) => ({
  from_phase_id: phaseId,
  to_phase_id: phaseId,
  state_policy: 'carry',
}));
const predecessor = {
  plan_version: currentPlan.plan_version,
  plan_digest: currentPlan.plan_digest,
  journal_head_digest: currentSnapshot.journal_head_digest,
};
const desiredSeed = {
  schema: 'lattice.todo_plan.v5',
  project_id: projectId,
  plan_key: planKey,
  predecessor_plan_digest: currentPlan.plan_digest,
  tasks,
  phases: currentPlan.phases,
  hard_dependencies: hardDependencies,
  joins: currentPlan.joins,
  phase_accept_dependencies: [{
    from: { project_id: projectId, plan_key: planKey, phase_id: 'phase-6' },
    to: ref('ace-072'),
  }],
};
desiredSeed.plan_version = phaseTodoRevisionPlanVersion({
  projectId,
  planKey,
  predecessor,
  desiredPlan: desiredSeed,
  taskMigration,
  phaseMigration,
});
const desiredPlan = buildTodoPlan(desiredSeed);
const taskMigrationDigest = todoSelfDigest({
  task_migration: taskMigration,
  task_migration_digest: '',
}, 'task_migration_digest');
const reconciliation = {
  predecessor_reconciliation_digest: currentRevision.reconciliation.reconciliation_digest,
  source_inventory_digest: todoSourceInventoryDigest(sourceInventory),
  desired_plan_digest: desiredPlan.plan_digest,
  runtime_task_migration_digest: runtimeTaskMigration.migration_digest,
  task_migration_digest: taskMigrationDigest,
  phase_migration_digest: digestTodoArtifact(phaseMigration),
  source_cutover_batch_digest: sourceCutoverBatch.batch_digest,
  reconciliation_digest: '',
};
reconciliation.reconciliation_digest = todoSelfDigest(reconciliation, 'reconciliation_digest');
const revision = {
  schema: 'lattice.phase_todo_revision.v3',
  project_id: projectId,
  plan_key: planKey,
  predecessor,
  desired_plan: desiredPlan,
  runtime_task_migration: runtimeTaskMigration,
  task_migration: taskMigration,
  phase_migration: phaseMigration,
  source_inventory: sourceInventory,
  reconciliation,
  source_cutover_batch: sourceCutoverBatch,
  revision_digest: '',
};
revision.revision_digest = todoSelfDigest(revision, 'revision_digest');
if (!validatePhaseTodoRevision(revision)) throw new Error('generated revision is invalid');
const output = path.join(repoRoot, '.lattice/import/aishell-product-order-revision-v1.json');
fs.writeFileSync(output, `${canonicalizeTodoArtifact(revision)}\n`, { flag: 'wx' });
process.stdout.write(`${JSON.stringify({
  schema: 'aishell.product_order_revision_build.v1',
  predecessor_plan_version: currentPlan.plan_version,
  desired_plan_version: desiredPlan.plan_version,
  revision_digest: revision.revision_digest,
  reset_tasks: [...resetTasks],
  source_cutover_operations: sourceCutoverBatch.operations.length,
})}\n`);
