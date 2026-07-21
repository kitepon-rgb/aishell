import fs from 'node:fs';
import path from 'node:path';
import { canonicalizeTodoArtifact } from '/Users/kite/Developer/Lattice/src/todo-contracts.mjs';

const repoRoot = path.resolve(new URL('../../', import.meta.url).pathname);
const latticeRoot = path.join(repoRoot, '.lattice');
const manifest = JSON.parse(fs.readFileSync(path.join(latticeRoot, 'todo/manifest.json')));
const descriptor = manifest.members.find(({ plan_key: planKey }) => (
  planKey === 'aishell-capability-expansion'
));
const plan = JSON.parse(fs.readFileSync(path.join(latticeRoot, 'todo/plans', descriptor.plan_key,
  descriptor.active_plan_version, 'plan.json')));
if (plan.schema !== 'lattice.todo_plan.v5') throw new Error('v5 active plan required');

const taskKey = ({ task_id: taskId }) => `task:${taskId}`;
const phaseKey = (phaseId) => `phase:${phaseId}`;
const taskNodes = plan.tasks.map(taskKey);
const taskEdges = [
  ...plan.hard_dependencies.map(({ from, to }) => [taskKey(from), taskKey(to)]),
  ...plan.joins.flatMap(({ after, before }) => after.map((from) => [taskKey(from), taskKey(before)])),
];

function layers(nodes, edges) {
  const incoming = new Map(nodes.map((node) => [node, new Set()]));
  const outgoing = new Map(nodes.map((node) => [node, new Set()]));
  for (const [from, to] of edges) {
    incoming.get(to).add(from);
    outgoing.get(from).add(to);
  }
  const remaining = new Set(nodes);
  const result = [];
  while (remaining.size > 0) {
    const ready = [...remaining].filter((node) => incoming.get(node).size === 0).sort();
    if (ready.length === 0) throw new Error('cycle in measured graph');
    result.push(ready);
    for (const node of ready) {
      remaining.delete(node);
      for (const target of outgoing.get(node)) incoming.get(target).delete(node);
    }
  }
  return result;
}

const phaseNodes = plan.phases.map(({ phase_id: phaseId }) => phaseKey(phaseId));
const membershipEdges = plan.tasks.map((task) => [taskKey(task), phaseKey(task.phase_id)]);
const auditOrderEdges = plan.phases.flatMap((phase) => phase.predecessor_phase_ids.map((from) => (
  [phaseKey(from), phaseKey(phase.phase_id)]
)));
const explicitEdges = plan.phase_accept_dependencies.map(({ from, to }) => (
  [phaseKey(from.phase_id), taskKey(to)]
));
const legacyUnlockEdges = plan.phases.flatMap((phase) => phase.predecessor_phase_ids.flatMap((from) => (
  plan.tasks.filter((task) => task.phase_id === phase.phase_id)
    .map((task) => [phaseKey(from), taskKey(task)])
)));

const taskLayers = layers(taskNodes, taskEdges);
const decoupledLayers = layers([...taskNodes, ...phaseNodes], [
  ...taskEdges, ...membershipEdges, ...auditOrderEdges, ...explicitEdges,
]);
const legacyLayers = layers([...taskNodes, ...phaseNodes], [
  ...taskEdges, ...membershipEdges, ...legacyUnlockEdges,
]);
const taskLayerCount = (value) => value.filter((layer) => layer.some((node) => node.startsWith('task:'))).length;
const maxTaskWidth = (value) => Math.max(...value.map((layer) => (
  layer.filter((node) => node.startsWith('task:')).length
)));
const result = {
  schema: 'aishell.phase_decoupling_measurement.v1',
  plan_version: plan.plan_version,
  task_count: plan.tasks.length,
  task_dependency_count: taskEdges.length,
  phase_count: plan.phases.length,
  explicit_phase_accept_dependency_count: plan.phase_accept_dependencies.length,
  task_dag: {
    rounds: taskLayers.length,
    task_rounds: taskLayerCount(taskLayers),
    max_task_width: maxTaskWidth(taskLayers),
  },
  legacy_phase_scheduling_model: {
    rounds: legacyLayers.length,
    task_rounds: taskLayerCount(legacyLayers),
    max_task_width: maxTaskWidth(legacyLayers),
  },
  decoupled_phase_audit_model: {
    rounds: decoupledLayers.length,
    task_rounds: taskLayerCount(decoupledLayers),
    max_task_width: maxTaskWidth(decoupledLayers),
  },
};
const output = path.join(latticeRoot, 'evidence/aishell-phase-decoupling-measurement-20260721.json');
fs.writeFileSync(output, `${canonicalizeTodoArtifact(result)}\n`, { flag: 'wx' });
process.stdout.write(`${JSON.stringify(result)}\n`);
