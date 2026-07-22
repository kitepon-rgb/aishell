import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));
const latticeSourceRoot = path.resolve(process.env.LATTICE_SOURCE_ROOT
  ?? path.join(repoRoot, '../Lattice'));
const contractsPath = path.join(latticeSourceRoot, 'src/todo-contracts.mjs');
const revisionPath = path.join(latticeSourceRoot, 'src/todo-revision.mjs');
const storePath = path.join(latticeSourceRoot, 'src/todo-store.mjs');
for (const modulePath of [contractsPath, revisionPath, storePath]) {
  if (!fs.existsSync(modulePath)) throw new Error(`Lattice source module missing: ${modulePath}`);
}

const {
  canonicalizeTodoArtifact,
  digestTodoArtifact,
  todoSelfDigest,
} = await import(pathToFileURL(contractsPath).href);
const {
  phaseTodoRevisionPlanVersion,
  todoSourceInventoryDigest,
  validatePhaseTodoRevision,
} = await import(pathToFileURL(revisionPath).href);
const { buildTodoPlan } = await import(pathToFileURL(storePath).href);

const latticeRoot = path.join(repoRoot, '.lattice');
const planRoot = path.join(latticeRoot, 'todo/plans/aishell-capability-expansion');
const authoringRef = '.lattice/import/aishell-overlap-seams.md';
const archiveRef = '.lattice/todo/source-ledger/aishell-missing-prerequisites-cutover.md';
const outputRef = '.lattice/import/aishell-missing-prerequisites-revision.json';
const compareText = (left, right) => left < right ? -1 : left > right ? 1 : 0;

const manifest = JSON.parse(fs.readFileSync(path.join(latticeRoot, 'todo/manifest.json')));
const member = manifest.members.find(({ plan_key: planKey }) => (
  planKey === 'aishell-capability-expansion'
));
if (member === undefined) throw new Error('active AIShell plan missing');
const activeRoot = path.join(planRoot, member.active_plan_version);
const currentPlan = JSON.parse(fs.readFileSync(path.join(activeRoot, 'plan.json')));
const currentSnapshot = JSON.parse(fs.readFileSync(path.join(activeRoot, 'snapshot.json')));
if (currentPlan.schema !== 'lattice.todo_plan.v5') throw new Error('v5 predecessor required');

const planByDigest = new Map();
for (const entry of fs.readdirSync(planRoot, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const directory = path.join(planRoot, entry.name);
  const planPath = path.join(directory, 'plan.json');
  if (!fs.existsSync(planPath)) continue;
  const plan = JSON.parse(fs.readFileSync(planPath));
  planByDigest.set(plan.plan_digest, { directory, plan });
}

let sourceRevision = null;
let cursor = { directory: activeRoot, plan: currentPlan };
while (cursor !== undefined) {
  const candidatePath = path.join(cursor.directory, 'revision.json');
  if (fs.existsSync(candidatePath)) {
    const candidate = JSON.parse(fs.readFileSync(candidatePath));
    if (candidate.source_inventory !== undefined && candidate.reconciliation !== undefined) {
      sourceRevision = candidate;
      break;
    }
  }
  cursor = cursor.plan.predecessor_plan_digest === null
    ? undefined : planByDigest.get(cursor.plan.predecessor_plan_digest);
}
if (sourceRevision === null) throw new Error('source reconciliation ancestor missing');

const projectId = currentPlan.project_id;
const planKey = currentPlan.plan_key;
const ref = (taskId) => ({ project_id: projectId, plan_key: planKey, task_id: taskId });
const newTaskSpecs = [
  ['ace-006', 'benchmark v2のexecution contract、materializer、observer projection、digestを統合実装前に凍結する。', 'phase-2', 'control', 6],
  ['ace-014', 'effective-root project catalogとdurable WorkspaceDeltaJournal retained viewを実装し、context/process共通のroot-scoped observation正本にする。', 'phase-2', 'workspace', 7],
  ['ace-044c', 'WorkspaceDeltaJournalとworkspace_waitを統合し、durable cursor replay、gap、timeout/cancelのfocused testを実装する。', 'phase-4', 'process', 9],
  ['ace-044d', 'MCPRequestSchedulerへrequest cancellationとsingle writerを分離し、managed job lifecycle非干渉のfocused testを実装する。', 'phase-4', 'process', 10],
];
const existingTaskIds = new Set(currentPlan.tasks.map(({ task_id: taskId }) => taskId));
for (const [taskId] of newTaskSpecs) {
  if (existingTaskIds.has(taskId)) throw new Error(`task already exists: ${taskId}`);
}

const authoringLines = fs.readFileSync(path.join(repoRoot, authoringRef), 'utf8').split('\n');
const sourceOperations = newTaskSpecs.map(([taskId, title, , , lineNumber]) => {
  const sourceLine = authoringLines[lineNumber - 1];
  if (!sourceLine?.includes(taskId.toUpperCase())) {
    throw new Error(`authoring source mismatch for ${taskId} at line ${lineNumber}`);
  }
  return {
    task_id: taskId,
    disposition: 'active',
    source_ref: `${authoringRef}#L${lineNumber}`,
    source_digest: createHash('sha256').update(sourceLine, 'utf8').digest('hex'),
    live_replacement: `- ${taskId.toUpperCase()} ${title}（工程状態はLattice正本）`,
  };
}).sort((left, right) => compareText(left.source_ref, right.source_ref));
const sourceCutoverBatch = {
  batch_id: 'aishell-missing-prerequisites-v1',
  archive_ref: archiveRef,
  operations: sourceOperations,
  batch_digest: '',
};
sourceCutoverBatch.batch_digest = todoSelfDigest(sourceCutoverBatch, 'batch_digest');
const archivedSourceRef = (taskId) => {
  const index = sourceOperations.findIndex((operation) => operation.task_id === taskId);
  if (index < 0) throw new Error(`source operation missing: ${taskId}`);
  return `${archiveRef}#L${index + 6}`;
};

const tasks = [
  ...currentPlan.tasks,
  ...newTaskSpecs.map(([taskId, title, phaseId, lane]) => ({
    task_id: taskId,
    title,
    lane,
    phase_id: phaseId,
    narrative_ref: archivedSourceRef(taskId),
    narrative_anchor: null,
    compile_binding: null,
    parent_task_id: null,
  })),
].sort((left, right) => compareText(left.task_id, right.task_id));

const edgePairs = currentPlan.hard_dependencies.map((edge) => (
  [edge.from.task_id, edge.to.task_id]
));
edgePairs.push(
  ['ace-002', 'ace-006'],
  ['ace-003', 'ace-006'],
  ['ace-004', 'ace-006'],
  ['ace-004', 'ace-014'],
  ['ace-012', 'ace-014'],
  ['ace-006', 'ace-023c'],
  ['ace-006', 'ace-044'],
  ['ace-014', 'ace-023c'],
  ['ace-014', 'ace-044'],
  ['ace-014', 'ace-044c'],
  ['ace-043', 'ace-044c'],
  ['ace-040', 'ace-044d'],
);
const edgeKey = ([from, to]) => (
  `${projectId}\0${planKey}\0${from}\0${projectId}\0${planKey}\0${to}`
);
const hardDependencies = [...new Map(edgePairs.map((pair) => [edgeKey(pair), pair])).values()]
  .sort((left, right) => compareText(edgeKey(left), edgeKey(right)))
  .map(([from, to]) => ({ from: ref(from), to: ref(to) }));

const joins = currentPlan.joins.map((join) => {
  if (join.id !== 'join-process-core') return join;
  const afterIds = [...new Set([
    ...join.after.map(({ task_id: taskId }) => taskId),
    'ace-044c',
    'ace-044d',
  ])].sort(compareText);
  return { ...join, after: afterIds.map(ref) };
}).sort((left, right) => compareText(left.id, right.id));

const resetReasons = new Map([
  ['ace-023c', 'benchmark v2 freezeと共通WorkspaceDeltaJournalの事前依存欠落を是正して再受入する'],
  ['ace-023', '再実行するSearchContextService v2をdefault profileへ再統合する'],
  ['ace-024', 'Phase 2の統合結果と測定を凍結済みbenchmark v2に対して再受入する'],
  ['ace-044', '開始前に必須だったbenchmark v2 freeze、共通journal、request scheduler工程を追加する'],
]);
const splitSuccessors = new Map([
  ['ace-023', ['ace-023', 'ace-006']],
  ['ace-023c', ['ace-023c', 'ace-014']],
  ['ace-044', ['ace-044', 'ace-044c', 'ace-044d']],
]);
const sourceDigestByTask = new Map([
  ...sourceRevision.source_inventory.active,
  ...sourceOperations,
].map(({ task_id: taskId, source_digest: sourceDigest }) => [taskId, sourceDigest]));
const runtimeTaskMigration = {
  schema: 'lattice.runtime_task_migration.v1',
  entries: currentPlan.tasks.map(({ task_id: taskId }) => {
    const resetReason = resetReasons.get(taskId);
    const successorTaskIds = splitSuccessors.get(taskId) ?? [taskId];
    const evidenceDigests = [...new Set(successorTaskIds.map((successorTaskId) => {
      const sourceDigest = sourceDigestByTask.get(successorTaskId);
      if (sourceDigest === undefined) throw new Error(`source evidence missing: ${successorTaskId}`);
      return sourceDigest;
    }))].sort(compareText);
    return {
      predecessor_task_id: taskId,
      disposition: splitSuccessors.has(taskId) ? 'split'
        : resetReason === undefined ? 'stay' : 'replace',
      successor_task_ids: successorTaskIds,
      reason: resetReason ?? '既存task identity、工程状態、証拠を意味変更なしで維持する',
      evidence_digests: evidenceDigests,
    };
  }).sort((left, right) => compareText(left.predecessor_task_id, right.predecessor_task_id)),
  migration_digest: '',
};
runtimeTaskMigration.migration_digest = todoSelfDigest(runtimeTaskMigration, 'migration_digest');
const taskMigration = runtimeTaskMigration.entries.map((entry) => ({
  from_task_id: entry.predecessor_task_id,
  to_task_id: entry.successor_task_ids[0],
  state_policy: ['replace', 'split'].includes(entry.disposition) ? 'reset_pending' : 'carry',
}));
const resetPhases = new Set(['phase-2', 'phase-4']);
const phaseMigration = currentPlan.phases.map(({ phase_id: phaseId }) => ({
  from_phase_id: phaseId,
  to_phase_id: phaseId,
  state_policy: resetPhases.has(phaseId) ? 'reset' : 'carry',
})).sort((left, right) => compareText(left.from_phase_id, right.from_phase_id));

const sourceInventory = {
  active: [
    ...sourceRevision.source_inventory.active,
    ...sourceOperations.map((operation) => ({
      task_id: operation.task_id,
      source_ref: archivedSourceRef(operation.task_id),
      source_digest: operation.source_digest,
    })),
  ].sort((left, right) => compareText(left.task_id, right.task_id)),
  excluded_tombstones: sourceRevision.source_inventory.excluded_tombstones,
};
const predecessor = {
  journal_head_digest: currentSnapshot.journal_head_digest,
  plan_digest: currentPlan.plan_digest,
  plan_version: currentPlan.plan_version,
};
const desiredSeed = {
  schema: 'lattice.todo_plan.v5',
  project_id: projectId,
  plan_key: planKey,
  predecessor_plan_digest: currentPlan.plan_digest,
  tasks,
  phases: currentPlan.phases,
  hard_dependencies: hardDependencies,
  joins,
  phase_accept_dependencies: currentPlan.phase_accept_dependencies,
};
const planVersion = phaseTodoRevisionPlanVersion({
  projectId,
  planKey,
  predecessor,
  desiredPlan: desiredSeed,
  taskMigration,
  phaseMigration,
  sourceInventory,
  sourceCutoverBatch,
});
const desiredPlan = buildTodoPlan({ ...desiredSeed, plan_version: planVersion });
const reconciliation = {
  predecessor_reconciliation_digest: sourceRevision.reconciliation.reconciliation_digest,
  source_inventory_digest: todoSourceInventoryDigest(sourceInventory),
  desired_plan_digest: desiredPlan.plan_digest,
  runtime_task_migration_digest: runtimeTaskMigration.migration_digest,
  task_migration_digest: todoSelfDigest({
    task_migration: taskMigration,
    task_migration_digest: '',
  }, 'task_migration_digest'),
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

if (!validatePhaseTodoRevision(revision)) {
  throw new Error('generated missing-prerequisites revision failed validation');
}
const output = path.join(repoRoot, outputRef);
fs.writeFileSync(output, `${canonicalizeTodoArtifact(revision)}\n`);
process.stdout.write(`${JSON.stringify({
  schema: 'aishell.missing_prerequisites_revision_build.v1',
  predecessor_plan_version: currentPlan.plan_version,
  predecessor_journal_head_digest: currentSnapshot.journal_head_digest,
  desired_plan_version: desiredPlan.plan_version,
  new_task_ids: newTaskSpecs.map(([taskId]) => taskId),
  reset_task_ids: [...resetReasons.keys()],
  reset_phase_ids: [...resetPhases],
  hard_predecessors: Object.fromEntries(['ace-023c', 'ace-044'].map((taskId) => [
    taskId,
    desiredPlan.hard_dependencies.filter(({ to }) => to.task_id === taskId)
      .map(({ from }) => from.task_id),
  ])),
})}\n`);
