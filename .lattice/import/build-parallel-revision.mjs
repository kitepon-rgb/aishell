import fs from 'node:fs';
import { createHash } from 'node:crypto';
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
const currentDir = new URL('todo/plans/aishell-capability-expansion/rev-8d5fbb1a63bd00cfce01a456/', root);
const currentPlan = JSON.parse(fs.readFileSync(new URL('plan.json', currentDir)));
const currentRevision = JSON.parse(fs.readFileSync(new URL('revision.json', currentDir)));
const currentSnapshot = JSON.parse(fs.readFileSync(new URL('snapshot.json', currentDir)));

const projectId = currentPlan.project_id;
const planKey = currentPlan.plan_key;
const compareText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const ref = (taskId) => ({ project_id: projectId, plan_key: planKey, task_id: taskId });
const binding = (compileResult, taskId) => ({
  boundary_manifest_digest: compileResult.manifests[taskId].manifest_digest,
  compiled_plan_digest: compileResult.plan.plan_digest,
  topology_digest: compileResult.graph_digest,
  base_sha: compileResult.plan.base_sha,
});

const compileA = JSON.parse(fs.readFileSync(new URL('evidence/aishell-parallel-wave-plan.json', root)));
const compileB = JSON.parse(fs.readFileSync(new URL('evidence/aishell-parallel-wave-b-plan.json', root)));
const compiled = new Map([
  ...compileA.plan.nodes.map(({ todo_id: id }) => [id, binding(compileA, id)]),
  ...compileB.plan.nodes.map(({ todo_id: id }) => [id, binding(compileB, id)]),
]);

const parentTitles = new Map([
  ['ace-012', '永続checkpointとobservation journalをWorkspaceStateRuntimeへ統合し、OS現在状態との照合を正本にする。'],
  ['ace-023', 'Git diff、project profile、search context v2をContextCompilerServiceと公開context toolへ統合する。'],
  ['ace-034', 'freshness cache、change impact、focused pipelineをDevelopmentRuntimeServiceへ統合し、silent fallbackを禁止する。'],
  ['ace-044', 'managed process、artifact query、workspace_waitを公開toolへ統合し、MCP request受付とjob lifecycleを分離する。'],
  ['ace-052', 'ChangeSetServiceをNativeFileServiceとworkspace runtimeへ統合し、成功deltaを追加scanなしで反映する。'],
]);

const newTaskSpecs = [
  ['ace-012a', 'WorkspaceCheckpointStoreとwarm restore/corruption focused testを専用fileへ実装する。', 'workspace', 'ace-012'],
  ['ace-012b', 'ObservationJournalとevent ID/gap/retention focused testを専用fileへ実装する。', 'workspace', 'ace-012'],
  ['ace-023a', 'GitContextProviderとdiff budget/continuation focused testを専用fileへ実装する。', 'context', 'ace-023'],
  ['ace-023b', 'ProjectProfileServiceとinvalidation focused testを専用fileへ実装する。', 'context', 'ace-023'],
  ['ace-023c', 'SearchContextService v2とshared budget/dedup/continuation focused testを専用fileへ実装する。', 'context', 'ace-023'],
  ['ace-034a', 'CheckFreshnessCacheとfalse-fresh/corruption/TTL focused testを専用fileへ実装する。', 'impact', 'ace-034'],
  ['ace-034b', 'ChangeImpactServiceとprovenance/freshness focused testを専用fileへ実装する。', 'impact', 'ace-034'],
  ['ace-044a', 'ManagedProcessRegistryとobserve/cancel/restart focused testを専用fileへ実装する。', 'process', 'ace-044'],
  ['ace-044b', 'ArtifactQueryServiceと横断search/history compare focused testを専用fileへ実装する。', 'process', 'ace-044'],
  ['ace-052a', 'ChangeSetServiceとatomicity/rollback/stale SHA focused testを専用fileへ実装する。', 'write', 'ace-052'],
];
const authoringRef = '.lattice/import/aishell-parallel-expansion.md';
const archiveRef = '.lattice/todo/source-ledger/aishell-parallel-expansion-cutover.md';
const authoringLines = fs.readFileSync(new URL('import/aishell-parallel-expansion.md', root), 'utf8').split('\n');
const sourceOperations = newTaskSpecs.map(([taskId, title], index) => {
  const lineNumber = index + 6;
  const sourceLine = authoringLines[lineNumber - 1];
  return {
    task_id: taskId,
    disposition: 'active',
    source_ref: `${authoringRef}#L${lineNumber}`,
    source_digest: createHash('sha256').update(sourceLine, 'utf8').digest('hex'),
    live_replacement: `- ${taskId.toUpperCase()} ${title}（工程状態はLattice正本）`,
  };
}).sort((a, b) => compareText(a.source_ref, b.source_ref));
const archivedSourceRef = (taskId) => {
  const index = sourceOperations.findIndex((operation) => operation.task_id === taskId);
  if (index < 0) throw new Error(`source operation missing: ${taskId}`);
  return `${archiveRef}#L${index + 6}`;
};
const sourceCutoverBatch = {
  batch_id: 'parallel-expansion-v1',
  archive_ref: archiveRef,
  operations: sourceOperations,
  batch_digest: '',
};
sourceCutoverBatch.batch_digest = todoSelfDigest(sourceCutoverBatch, 'batch_digest');

const tasks = currentPlan.tasks.map((task) => ({
  ...task,
  title: parentTitles.get(task.task_id) ?? task.title,
}));
tasks.push(...newTaskSpecs.map(([taskId, title, lane, parentTaskId]) => ({
  task_id: taskId,
  title,
  lane,
  narrative_ref: archivedSourceRef(taskId),
  narrative_anchor: null,
  compile_binding: compiled.get(taskId),
  parent_task_id: parentTaskId,
})));
tasks.sort((a, b) => compareText(a.task_id, b.task_id));

const removedEdges = new Set([
  'ace-011>ace-012',
  'ace-020>ace-021', 'ace-021>ace-022', 'ace-022>ace-023',
  'ace-031>ace-032', 'ace-032>ace-033', 'ace-033>ace-034',
  'ace-041>ace-042', 'ace-042>ace-043', 'ace-043>ace-044',
  'ace-051>ace-052',
  'ace-060>ace-064', 'ace-061>ace-064', 'ace-062>ace-064', 'ace-063>ace-064',
]);
const edgePairs = currentPlan.hard_dependencies
  .map((edge) => [edge.from.task_id, edge.to.task_id])
  .filter(([from, to]) => !removedEdges.has(`${from}>${to}`));
edgePairs.push(
  ['ace-011', 'ace-012a'], ['ace-011', 'ace-012b'],
  ['ace-013', 'ace-021'], ['ace-013', 'ace-022'],
  ['ace-020', 'ace-023a'], ['ace-021', 'ace-023b'], ['ace-022', 'ace-023c'],
  ['ace-024', 'ace-032'], ['ace-024', 'ace-033'],
  ['ace-031', 'ace-034a'], ['ace-032', 'ace-034b'],
  ['ace-035', 'ace-042'], ['ace-035', 'ace-043'],
  ['ace-041', 'ace-044a'], ['ace-042', 'ace-044b'],
  ['ace-051', 'ace-052a'], ['ace-052a', 'ace-052'],
);
const edgeKey = ([from, to]) => `${projectId}\0${planKey}\0${from}\0${projectId}\0${planKey}\0${to}`;
const hardDependencies = [...new Map(edgePairs.map((pair) => [edgeKey(pair), pair])).values()]
  .sort((a, b) => compareText(edgeKey(a), edgeKey(b)))
  .map(([from, to]) => ({ from: ref(from), to: ref(to) }));

const joins = [
  ['join-workspace-core', ['ace-012a', 'ace-012b'], 'ace-012'],
  ['join-context-core', ['ace-023a', 'ace-023b', 'ace-023c'], 'ace-023'],
  ['join-impact-core', ['ace-033', 'ace-034a', 'ace-034b'], 'ace-034'],
  ['join-process-core', ['ace-043', 'ace-044a', 'ace-044b'], 'ace-044'],
  ['join-analysis-adapters', ['ace-060', 'ace-061', 'ace-062', 'ace-063'], 'ace-064'],
].map(([id, after, before]) => ({ id, after: after.sort().map(ref), before: ref(before) }))
  .sort((a, b) => compareText(a.id, b.id));

const predecessor = {
  plan_version: currentPlan.plan_version,
  plan_digest: currentPlan.plan_digest,
  journal_head_digest: currentSnapshot.journal_head_digest,
};
const sourceInventory = {
  active: [
    ...currentRevision.source_inventory.active,
    ...sourceOperations.map((operation, index) => ({
      task_id: operation.task_id,
      source_ref: `${archiveRef}#L${index + 6}`,
      source_digest: operation.source_digest,
    })),
  ].sort((a, b) => compareText(a.task_id, b.task_id)),
  excluded_tombstones: currentRevision.source_inventory.excluded_tombstones,
};
const taskMigration = currentPlan.tasks.map(({ task_id: taskId }) => ({
  from_task_id: taskId,
  to_task_id: taskId,
  state_policy: 'reset_pending',
}));
const desiredSeed = {
  schema: 'lattice.todo_plan.v3', project_id: projectId, plan_key: planKey,
  predecessor_plan_digest: currentPlan.plan_digest,
  tasks, hard_dependencies: hardDependencies, joins,
};
const planVersion = todoRevisionPlanVersion({
  projectId, planKey, predecessor, desiredPlan: desiredSeed,
  taskMigration, sourceInventory, sourceCutoverBatch,
});
const topology = { project_id: projectId, plan_key: planKey, plan_version: planVersion, tasks, hard_dependencies: hardDependencies, joins };
const desiredPlan = {
  ...desiredSeed,
  plan_version: planVersion,
  topology_digest: digestTodoArtifact(topology),
  plan_digest: '',
};
desiredPlan.plan_digest = todoSelfDigest(desiredPlan, 'plan_digest');

const sourceInventoryDigest = todoSourceInventoryDigest(sourceInventory);
const reconciliation = {
  predecessor_reconciliation_digest: currentRevision.reconciliation.reconciliation_digest,
  source_inventory_digest: sourceInventoryDigest,
  reconciliation_digest: todoReconciliationDigest({
    predecessorReconciliationDigest: currentRevision.reconciliation.reconciliation_digest,
    sourceInventoryDigest,
    predecessor,
    desiredPlanDigest: desiredPlan.plan_digest,
    taskMigration,
    sourceCutoverBatch,
  }),
};
const revision = {
  schema: 'lattice.todo_revision.v2', project_id: projectId, plan_key: planKey,
  predecessor, desired_plan: desiredPlan, task_migration: taskMigration,
  source_inventory: sourceInventory, reconciliation, source_cutover_batch: sourceCutoverBatch,
  revision_digest: '',
};
revision.revision_digest = todoSelfDigest(revision, 'revision_digest');
const planValid = validateTodoPlan(desiredPlan);
const revisionValid = validateTodoRevision(revision);
if ((!planValid || !revisionValid) && process.env.LATTICE_DEBUG !== '1') {
  throw new Error(`generated revision failed validation: plan=${planValid} revision=${revisionValid}`);
}
process.stdout.write(canonicalizeTodoArtifact(revision));
