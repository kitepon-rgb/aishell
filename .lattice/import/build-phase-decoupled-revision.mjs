import fs from 'node:fs';
import path from 'node:path';
import {
  buildTodoPlan,
} from '/Users/kite/Developer/Lattice/src/todo-store.mjs';
import {
  canonicalizeTodoArtifact,
  todoSelfDigest,
} from '/Users/kite/Developer/Lattice/src/todo-contracts.mjs';
import {
  phaseTodoRevisionPlanVersion,
  validatePhaseTodoRevision,
} from '/Users/kite/Developer/Lattice/src/todo-revision.mjs';

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
if (currentPlan.schema !== 'lattice.todo_plan.v4') throw new Error('v4 predecessor required');

const predecessor = {
  journal_head_digest: currentSnapshot.journal_head_digest,
  plan_digest: currentPlan.plan_digest,
  plan_version: currentPlan.plan_version,
};
const phaseAcceptDependencies = [{
  from: { project_id: currentPlan.project_id, plan_key: currentPlan.plan_key, phase_id: 'phase-6' },
  to: { project_id: currentPlan.project_id, plan_key: currentPlan.plan_key, task_id: 'ace-070' },
}];
const taskMigration = currentPlan.tasks.map(({ task_id: taskId }) => ({
  from_task_id: taskId,
  state_policy: taskId === 'ace-070' ? 'reset_pending' : 'carry',
  to_task_id: taskId,
}));
const phaseMigration = currentPlan.phases.map(({ phase_id: phaseId }) => ({
  from_phase_id: phaseId,
  state_policy: 'reset',
  to_phase_id: phaseId,
}));
const desiredSeed = {
  schema: 'lattice.todo_plan.v5',
  project_id: currentPlan.project_id,
  plan_key: currentPlan.plan_key,
  predecessor_plan_digest: currentPlan.plan_digest,
  tasks: currentPlan.tasks,
  phases: currentPlan.phases,
  hard_dependencies: currentPlan.hard_dependencies,
  joins: currentPlan.joins,
  phase_accept_dependencies: phaseAcceptDependencies,
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
const output = path.join(latticeRoot, 'import/aishell-phase-decoupled-revision-v1.json');
fs.writeFileSync(output, `${canonicalizeTodoArtifact(revision)}\n`, { flag: 'wx' });
process.stdout.write(`${JSON.stringify({
  schema: 'aishell.phase_decoupled_revision_build.v1',
  predecessor_plan_version: currentPlan.plan_version,
  desired_plan_version: desiredPlan.plan_version,
  task_count: desiredPlan.tasks.length,
  phase_count: desiredPlan.phases.length,
  phase_accept_dependency_count: desiredPlan.phase_accept_dependencies.length,
})}\n`);
