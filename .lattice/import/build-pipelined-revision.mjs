import fs from 'node:fs';
import {
  canonicalizeTodoArtifact,
  digestTodoArtifact,
  todoSelfDigest,
  validateTodoPlan,
} from '/opt/homebrew/lib/node_modules/@quolu/lattice/src/todo-contracts.mjs';
import {
  todoReconciliationDigest,
  todoRevisionPlanVersion,
  todoSourceInventoryDigest,
  validateTodoRevision,
} from '/opt/homebrew/lib/node_modules/@quolu/lattice/src/todo-revision.mjs';

const root = new URL('../', import.meta.url);
const currentDir = new URL('todo/plans/aishell-capability-expansion/rev-0c0b59f2aca1df203dbb23f9/', root);
const currentPlan = JSON.parse(fs.readFileSync(new URL('plan.json', currentDir)));
const currentRevision = JSON.parse(fs.readFileSync(new URL('revision.json', currentDir)));
const currentSnapshot = JSON.parse(fs.readFileSync(new URL('snapshot.json', currentDir)));
const projectId = currentPlan.project_id;
const planKey = currentPlan.plan_key;
const compareText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const ref = (taskId) => ({ project_id: projectId, plan_key: planKey, task_id: taskId });

const removed = new Set([
  'ace-013>ace-020', 'ace-013>ace-021', 'ace-013>ace-022',
  'ace-024>ace-030', 'ace-024>ace-032', 'ace-024>ace-033',
  'ace-035>ace-040', 'ace-035>ace-042', 'ace-035>ace-043',
  'ace-045>ace-050', 'ace-052a>ace-052',
]);
const pairs = currentPlan.hard_dependencies
  .map((edge) => [edge.from.task_id, edge.to.task_id])
  .filter(([from, to]) => !removed.has(`${from}>${to}`));
for (const suffix of ['020', '021', '022', '030', '032', '033', '040', '042', '043', '050']) {
  pairs.push(['ace-003', `ace-${suffix}`]);
}
const edgeKey = ([from, to]) => `${projectId}\0${planKey}\0${from}\0${projectId}\0${planKey}\0${to}`;
const hardDependencies = [...new Map(pairs.map((pair) => [edgeKey(pair), pair])).values()]
  .sort((a, b) => compareText(edgeKey(a), edgeKey(b)))
  .map(([from, to]) => ({ from: ref(from), to: ref(to) }));

const extraJoinAfter = new Map([
  ['ace-023', 'ace-013'],
  ['ace-034', 'ace-024'],
  ['ace-044', 'ace-035'],
]);
const joins = currentPlan.joins.map((join) => {
  const beforeId = join.before.task_id;
  const ids = join.after.map((entry) => entry.task_id);
  const extra = extraJoinAfter.get(beforeId);
  if (extra !== undefined) ids.push(extra);
  return { id: join.id, after: [...new Set(ids)].sort().map(ref), before: ref(beforeId) };
});
joins.push({ id: 'join-write-core', after: ['ace-045', 'ace-052a'].map(ref), before: ref('ace-052') });
joins.sort((a, b) => compareText(a.id, b.id));

const tasks = currentPlan.tasks;
const sourceInventory = currentRevision.source_inventory;
const taskMigration = tasks.map(({ task_id: taskId }) => ({
  from_task_id: taskId,
  to_task_id: taskId,
  state_policy: 'reset_pending',
}));
const predecessor = {
  plan_version: currentPlan.plan_version,
  plan_digest: currentPlan.plan_digest,
  journal_head_digest: currentSnapshot.journal_head_digest,
};
const desiredSeed = {
  schema: 'lattice.todo_plan.v3', project_id: projectId, plan_key: planKey,
  predecessor_plan_digest: currentPlan.plan_digest,
  tasks, hard_dependencies: hardDependencies, joins,
};
const planVersion = todoRevisionPlanVersion({
  projectId, planKey, predecessor, desiredPlan: desiredSeed, taskMigration, sourceInventory,
});
const topology = { project_id: projectId, plan_key: planKey, plan_version: planVersion, tasks, hard_dependencies: hardDependencies, joins };
const desiredPlan = {
  ...desiredSeed, plan_version: planVersion,
  topology_digest: digestTodoArtifact(topology), plan_digest: '',
};
desiredPlan.plan_digest = todoSelfDigest(desiredPlan, 'plan_digest');
const sourceInventoryDigest = todoSourceInventoryDigest(sourceInventory);
const reconciliation = {
  predecessor_reconciliation_digest: currentRevision.reconciliation.reconciliation_digest,
  source_inventory_digest: sourceInventoryDigest,
  reconciliation_digest: todoReconciliationDigest({
    predecessorReconciliationDigest: currentRevision.reconciliation.reconciliation_digest,
    sourceInventoryDigest, predecessor, desiredPlanDigest: desiredPlan.plan_digest, taskMigration,
  }),
};
const revision = {
  schema: 'lattice.todo_revision.v1', project_id: projectId, plan_key: planKey,
  predecessor, desired_plan: desiredPlan, task_migration: taskMigration,
  source_inventory: sourceInventory, reconciliation, revision_digest: '',
};
revision.revision_digest = todoSelfDigest(revision, 'revision_digest');
if (!validateTodoPlan(desiredPlan) || !validateTodoRevision(revision)) {
  throw new Error('generated pipelined revision failed validation');
}
process.stdout.write(canonicalizeTodoArtifact(revision));
