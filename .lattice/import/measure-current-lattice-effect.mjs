import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import {
  canonicalizeTodoArtifact,
  todoSelfDigest,
} from '/Users/kite/Developer/Lattice/src/todo-contracts.mjs';

const AISHELL_ROOT = path.resolve(new URL('../../', import.meta.url).pathname);
const LATTICE_ROOT = '/Users/kite/Developer/Lattice';
const LATTICE_CLI = path.join(LATTICE_ROOT, 'bin/lattice.mjs');
const PLAN_KEY = 'aishell-capability-expansion';

function run(executable, args, cwd) {
  const started = performance.now();
  const result = spawnSync(executable, args, { cwd, encoding: 'utf8' });
  const durationMs = Math.round(performance.now() - started);
  if (result.status !== 0) {
    throw new Error(`${executable} ${args.join(' ')} failed (${result.status}): ${result.stderr || result.stdout}`);
  }
  return { stdout: result.stdout.trim(), duration_ms: durationMs };
}

function runJson(executable, args, cwd) {
  const result = run(executable, args, cwd);
  return { value: JSON.parse(result.stdout), duration_ms: result.duration_ms };
}

function gitHead(root) {
  return run('git', ['rev-parse', 'HEAD'], root).stdout;
}

function taskKey({ task_id: taskId }) {
  return `task:${taskId}`;
}

function phaseKey(phaseId) {
  return `phase:${phaseId}`;
}

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

function schedulingMeasurement(plan) {
  const taskNodes = plan.tasks.map(taskKey);
  const phaseNodes = plan.phases.map(({ phase_id: phaseId }) => phaseKey(phaseId));
  const taskEdges = [
    ...plan.hard_dependencies.map(({ from, to }) => [taskKey(from), taskKey(to)]),
    ...plan.joins.flatMap(({ after, before }) => after.map((from) => [taskKey(from), taskKey(before)])),
  ];
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
  const taskOnly = layers(taskNodes, taskEdges);
  const legacy = layers([...taskNodes, ...phaseNodes], [
    ...taskEdges, ...membershipEdges, ...legacyUnlockEdges,
  ]);
  const decoupled = layers([...taskNodes, ...phaseNodes], [
    ...taskEdges, ...membershipEdges, ...auditOrderEdges, ...explicitEdges,
  ]);
  const metrics = (value) => ({
    rounds: value.length,
    task_rounds: value.filter((layer) => layer.some((node) => node.startsWith('task:'))).length,
    max_task_width: Math.max(...value.map((layer) => (
      layer.filter((node) => node.startsWith('task:')).length
    ))),
  });
  return {
    task_count: plan.tasks.length,
    hard_dependency_count: plan.hard_dependencies.length,
    expanded_join_edge_count: taskEdges.length - plan.hard_dependencies.length,
    phase_count: plan.phases.length,
    explicit_phase_accept_dependency_count: plan.phase_accept_dependencies.length,
    task_dag: metrics(taskOnly),
    v4_implicit_phase_gate_model: metrics(legacy),
    v5_decoupled_phase_audit_model: metrics(decoupled),
  };
}

function createInput(schema) {
  const v5 = schema === 'lattice.plan_create_input.v3';
  const value = {
    schema,
    project_id: v5 ? 'effect-v5' : 'effect-v4',
    plan_key: 'main',
    plan_version: 'v1',
    actor: { host: 'measure-host', session: 'measure-session', agent: 'measure-agent' },
    recorded_at: new Date().toISOString(),
    tasks: [
      { task_id: 'T1', title: 'Phase 1 task', lane: 'main', narrative_ref: null,
        narrative_anchor: null, compile_binding: null, parent_task_id: null, phase_id: 'phase-1' },
      { task_id: 'T2', title: 'Independent Phase 2 task', lane: 'main', narrative_ref: null,
        narrative_anchor: null, compile_binding: null, parent_task_id: null, phase_id: 'phase-2' },
      { task_id: 'T3', title: 'Explicitly gated Phase 2 task', lane: 'main', narrative_ref: null,
        narrative_anchor: null, compile_binding: null, parent_task_id: null, phase_id: 'phase-2' },
    ],
    phases: [
      { phase_id: 'phase-1', title: 'Phase 1', gate_policy: 'heavy', predecessor_phase_ids: [],
        required_evidence_slots: ['heavy'] },
      { phase_id: 'phase-2', title: 'Phase 2', gate_policy: 'heavy', predecessor_phase_ids: ['phase-1'],
        required_evidence_slots: ['heavy'] },
    ],
    hard_dependencies: [],
    joins: [],
    ...(v5 ? { phase_accept_dependencies: [{
      from: { project_id: 'effect-v5', plan_key: 'main', phase_id: 'phase-1' },
      to: { project_id: 'effect-v5', plan_key: 'main', task_id: 'T3' },
    }] } : {}),
    input_digest: '',
  };
  value.input_digest = todoSelfDigest(value, 'input_digest');
  return value;
}

async function readinessFixture(schema) {
  const root = await mkdtemp(path.join(os.tmpdir(), `lattice-effect-${schema.endsWith('v3') ? 'v5' : 'v4'}-`));
  try {
    run('git', ['init', '--quiet'], root);
    await mkdir(path.join(root, '.lattice'));
    const input = createInput(schema);
    await writeFile(path.join(root, '.lattice/plan-create.json'), `${canonicalizeTodoArtifact(input)}\n`);
    const create = runJson(process.execPath, [LATTICE_CLI, 'plan', 'create', '--input',
      '.lattice/plan-create.json'], root);
    const status = runJson(process.execPath, [LATTICE_CLI, 'todo', 'status', '--json'], root);
    const phases = runJson(process.execPath, [LATTICE_CLI, 'todo', 'phase', 'status', '--plan', 'main'], root);
    return {
      input_schema: schema,
      created_plan_version: create.value.plan_version,
      next_ready: status.value.next_ready.map(({ task_id: taskId }) => taskId),
      phase_statuses: phases.value.phases.map(({ phase_id: phaseId, status: phaseStatus }) => ({
        phase_id: phaseId, status: phaseStatus,
      })),
      create_duration_ms: create.duration_ms,
      status_duration_ms: status.duration_ms,
    };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function freshSensorMeasurement() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lattice-effect-fresh-'));
  try {
    run('git', ['clone', '--shared', '--quiet', AISHELL_ROOT, root], AISHELL_ROOT);
    if (fs.existsSync(path.join(root, '.codegraph'))) throw new Error('fresh clone unexpectedly contains .codegraph');
    const sourceHead = gitHead(root);
    if (sourceHead !== gitHead(AISHELL_ROOT)) throw new Error('fresh clone HEAD mismatch');
    const init = runJson(process.execPath, [LATTICE_CLI, 'sensor', 'init', '.', '--json'], root);
    if (!fs.existsSync(path.join(root, '.codegraph', 'codegraph.db'))) {
      throw new Error('current bundled Lattice sensor did not create a fresh index');
    }
    const sync = runJson(process.execPath, [LATTICE_CLI, 'sensor', 'sync', '.', '--json'], root);
    if (sync.value.provider !== 'lattice' || sync.value.sensor_owner !== 'lattice'
      || sync.value.status !== 'ok') throw new Error('Lattice sensor identity mismatch');
    const requestRefs = [
      '.lattice/import/aishell-parallel-wave-request.json',
      '.lattice/import/aishell-parallel-wave-b-request.json',
    ];
    const compiles = requestRefs.map((requestRef) => {
      const request = JSON.parse(fs.readFileSync(path.join(AISHELL_ROOT, requestRef), 'utf8'));
      const compiled = runJson(process.execPath, [LATTICE_CLI, 'plan', 'compile', '--request',
        path.join(AISHELL_ROOT, requestRef)], root);
      const manifests = Object.values(compiled.value.manifests);
      return {
        request_ref: requestRef,
        todo_count: request.todos.length,
        executor_capacity: request.capacity.executors,
        wave_count: compiled.value.schedule.waves.length,
        minimum_feasible_waves: compiled.value.schedule.minimum_feasible_waves,
        wave_widths: compiled.value.schedule.waves.map(({ todo_ids: todoIds }) => todoIds.length),
        conflict_count: compiled.value.plan.conflicts.length,
        unknown_count: manifests.reduce((sum, manifest) => sum + manifest.unknowns.length, 0),
        graph_evidence_not_ready_count: manifests.reduce((sum, manifest) => sum
          + manifest.graph_evidence.filter(({ status }) => status !== 'ready').length, 0),
        compile_duration_ms: compiled.duration_ms,
        plan_digest: compiled.value.plan.plan_digest,
        graph_digest: compiled.value.graph_digest,
      };
    });
    return {
      fresh_clone_head: sourceHead,
      preexisting_legacy_cache_present: false,
      fresh_legacy_named_cache_generated_by_current_lattice: true,
      sensor: {
        init_provider: init.value.provider,
        init_sensor_owner: init.value.sensor_owner,
        init_status: init.value.status,
        init_duration_ms: init.duration_ms,
        provider: sync.value.provider,
        sensor_owner: sync.value.sensor_owner,
        status: sync.value.status,
        sensor_version: sync.value.sensor_version,
        sync_duration_ms: sync.duration_ms,
      },
      compiles,
    };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const manifest = JSON.parse(fs.readFileSync(path.join(AISHELL_ROOT, '.lattice/todo/manifest.json')));
const descriptor = manifest.members.find(({ plan_key: planKey }) => planKey === PLAN_KEY);
if (descriptor === undefined) throw new Error('AIShell active plan missing');
const plan = JSON.parse(fs.readFileSync(path.join(AISHELL_ROOT, '.lattice/todo/plans', PLAN_KEY,
  descriptor.active_plan_version, 'plan.json')));
if (plan.schema !== 'lattice.todo_plan.v5') throw new Error('AIShell v5 plan required');

const [sensor, v4Fixture, v5Fixture] = await Promise.all([
  freshSensorMeasurement(),
  readinessFixture('lattice.plan_create_input.v2'),
  readinessFixture('lattice.plan_create_input.v3'),
]);
const scheduling = schedulingMeasurement(plan);
const result = {
  schema: 'aishell.current_lattice_effect_measurement.v1',
  measured_at: '2026-07-21',
  aishell_head: gitHead(AISHELL_ROOT),
  lattice_head: gitHead(LATTICE_ROOT),
  lattice_cli_ref: LATTICE_CLI,
  legacy_codegraph_input_used: false,
  sensor,
  readiness_comparison: {
    v4: v4Fixture,
    v5: v5Fixture,
    independent_ready_gain: v5Fixture.next_ready.length - v4Fixture.next_ready.length,
  },
  aishell_scheduling: scheduling,
  derived_effect: {
    combined_round_reduction: scheduling.v4_implicit_phase_gate_model.rounds
      - scheduling.v5_decoupled_phase_audit_model.rounds,
    combined_round_reduction_millipercent: Math.round((
      (scheduling.v4_implicit_phase_gate_model.rounds
        - scheduling.v5_decoupled_phase_audit_model.rounds)
      / scheduling.v4_implicit_phase_gate_model.rounds
    ) * 100_000),
    phase_count_change: 0,
  },
  interpretation_limits: {
    actual_wall_time_reduction_claimed: false,
    boundary_correctness_proven_by_zero_conflicts: false,
    compile_durations_are_single_run_reference_only: true,
    bundled_sensor_cutover_complete_claimed: false,
    bundled_sensor_cutover_finding: 'public identity is lattice, but fresh init still creates .codegraph/codegraph.db and bundled help text identifies CodeGraph',
  },
};
const output = process.argv[2] === undefined
  ? path.join(AISHELL_ROOT, '.lattice/evidence/aishell-current-lattice-effect-measurement-20260721.json')
  : path.resolve(process.argv[2]);
fs.writeFileSync(output, `${canonicalizeTodoArtifact(result)}\n`, { flag: 'wx' });
process.stdout.write(`${JSON.stringify(result)}\n`);
