import fs from 'node:fs';
import path from 'node:path';

import { buildTodoPlan } from '/opt/homebrew/lib/node_modules/@quolu/lattice/src/todo-store.mjs';
import {
  canonicalizeTodoArtifact,
  todoSelfDigest,
} from '/opt/homebrew/lib/node_modules/@quolu/lattice/src/todo-contracts.mjs';
import {
  phaseTodoRevisionPlanVersion,
  validatePhaseTodoRevision,
} from '/opt/homebrew/lib/node_modules/@quolu/lattice/src/todo-revision.mjs';

const repoRoot = path.resolve(new URL('../../', import.meta.url).pathname);
const latticeRoot = path.join(repoRoot, '.lattice');
const manifest = JSON.parse(fs.readFileSync(path.join(latticeRoot, 'todo/manifest.json')));
const descriptor = manifest.members.find(({ plan_key: planKey }) => (
  planKey === 'aishell-capability-expansion'
));
if (descriptor === undefined) throw new Error('active plan missing');
const activeRoot = path.join(latticeRoot, 'todo/plans', descriptor.plan_key,
  descriptor.active_plan_version);
const currentPlan = JSON.parse(fs.readFileSync(path.join(activeRoot, 'plan.json')));
const currentSnapshot = JSON.parse(fs.readFileSync(path.join(activeRoot, 'snapshot.json')));
if (currentPlan.schema !== 'lattice.todo_plan.v5') throw new Error('v5 predecessor required');

let changedTitles = 0;
const tasks = currentPlan.tasks.map((task) => {
  if (!task.title.includes('現行0.3.2')) return task;
  changedTitles += 1;
  return { ...task, title: task.title.replace('現行0.3.2', '現行0.3.3') };
});
if (changedTitles !== 2) throw new Error(`expected 2 baseline titles, got ${changedTitles}`);

const predecessor = {
  journal_head_digest: currentSnapshot.journal_head_digest,
  plan_digest: currentPlan.plan_digest,
  plan_version: currentPlan.plan_version,
};
const changedTaskIds = new Set(tasks.filter((task, index) => (
  task.title !== currentPlan.tasks[index].title
)).map(({ task_id: taskId }) => taskId));
const taskMigration = currentPlan.tasks.map(({ task_id: taskId }) => ({
  from_task_id: taskId,
  state_policy: changedTaskIds.has(taskId) ? 'reset_pending' : 'carry',
  to_task_id: taskId,
}));
const phaseMigration = currentPlan.phases.map(({ phase_id: phaseId }) => ({
  from_phase_id: phaseId,
  state_policy: 'carry',
  to_phase_id: phaseId,
}));
const desiredSeed = {
  schema: currentPlan.schema,
  project_id: currentPlan.project_id,
  plan_key: currentPlan.plan_key,
  predecessor_plan_digest: currentPlan.plan_digest,
  tasks,
  phases: currentPlan.phases,
  hard_dependencies: currentPlan.hard_dependencies,
  joins: currentPlan.joins,
  phase_accept_dependencies: currentPlan.phase_accept_dependencies,
};
const planVersion = phaseTodoRevisionPlanVersion({
  projectId: currentPlan.project_id,
  planKey: currentPlan.plan_key,
  predecessor,
  desiredPlan: desiredSeed,
  taskMigration,
  phaseMigration,
});
const desiredPlan = buildTodoPlan({ ...desiredSeed, plan_version: planVersion });
const revision = {
  schema: 'lattice.phase_todo_revision.v2',
  project_id: currentPlan.project_id,
  plan_key: currentPlan.plan_key,
  predecessor,
  desired_plan: desiredPlan,
  task_migration: taskMigration,
  phase_migration: phaseMigration,
  revision_digest: '',
};
revision.revision_digest = todoSelfDigest(revision, 'revision_digest');
if (!validatePhaseTodoRevision(revision)) throw new Error('generated revision is invalid');
const output = path.join(latticeRoot, 'import/aishell-baseline-0.3.3-revision-v2.json');
fs.writeFileSync(output, `${canonicalizeTodoArtifact(revision)}\n`, { flag: 'wx' });
process.stdout.write(`${JSON.stringify({
  schema: 'aishell.baseline_revision_build.v1',
  predecessor_plan_version: currentPlan.plan_version,
  desired_plan_version: desiredPlan.plan_version,
  reset_task_ids: [...changedTaskIds],
})}\n`);
