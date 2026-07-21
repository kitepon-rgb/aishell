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
const currentDir = new URL('todo/plans/aishell-capability-expansion/rev-1c489fc6618296f61bcacf1c/', root);
const currentPlan = JSON.parse(fs.readFileSync(new URL('plan.json', currentDir)));
const currentRevision = JSON.parse(fs.readFileSync(new URL('revision.json', currentDir)));
const currentSnapshot = JSON.parse(fs.readFileSync(new URL('snapshot.json', currentDir)));
const compileResults = [
  JSON.parse(fs.readFileSync(new URL('evidence/aishell-parallel-wave-plan.json', root))),
  JSON.parse(fs.readFileSync(new URL('evidence/aishell-parallel-wave-b-plan.json', root))),
];
const bindings = new Map();
for (const result of compileResults) {
  for (const { todo_id: taskId } of result.plan.nodes) {
    bindings.set(taskId, {
      boundary_manifest_digest: result.manifests[taskId].manifest_digest,
      compiled_plan_digest: result.plan.plan_digest,
      topology_digest: result.graph_digest,
      base_sha: result.plan.base_sha,
    });
  }
}
const tasks = currentPlan.tasks.map((task) => bindings.has(task.task_id)
  ? { ...task, compile_binding: bindings.get(task.task_id) }
  : task);
const projectId = currentPlan.project_id;
const planKey = currentPlan.plan_key;
const predecessor = {
  plan_version: currentPlan.plan_version,
  plan_digest: currentPlan.plan_digest,
  journal_head_digest: currentSnapshot.journal_head_digest,
};
const sourceInventory = currentRevision.source_inventory;
const taskMigration = tasks.map(({ task_id: taskId }) => ({
  from_task_id: taskId,
  to_task_id: taskId,
  state_policy: 'reset_pending',
}));
const desiredSeed = {
  schema: 'lattice.todo_plan.v3', project_id: projectId, plan_key: planKey,
  predecessor_plan_digest: currentPlan.plan_digest,
  tasks, hard_dependencies: currentPlan.hard_dependencies, joins: currentPlan.joins,
};
const planVersion = todoRevisionPlanVersion({
  projectId, planKey, predecessor, desiredPlan: desiredSeed, taskMigration, sourceInventory,
});
const topology = {
  project_id: projectId, plan_key: planKey, plan_version: planVersion,
  tasks, hard_dependencies: currentPlan.hard_dependencies, joins: currentPlan.joins,
};
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
  throw new Error('generated rebound revision failed validation');
}
process.stdout.write(canonicalizeTodoArtifact(revision));
