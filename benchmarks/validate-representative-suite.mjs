#!/usr/bin/env node

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { generatedTreeDigest } from './materialize-generated-seed.mjs';
import { renderRepresentativePrompt } from './render-representative-prompt.mjs';

const suite = JSON.parse(await readFile(new URL('./representative-suite.v1.json', import.meta.url)));
const catalog = JSON.parse(await readFile(new URL('./capability-fixtures.v1.json', import.meta.url)));
const goals = JSON.parse(await readFile(new URL('./representative-task-goals.v1.json', import.meta.url)));
const execution = JSON.parse(await readFile(new URL('./representative-execution-contracts.v1.json', import.meta.url)));

assert.equal(suite.schemaVersion, 'aishell.representative-suite.v1');
assert.equal(catalog.schemaVersion, 'aishell.capability-fixtures.v1');
assert.equal(goals.schemaVersion, 'aishell.representative-task-goals.v1');
assert.equal(execution.schemaVersion, 'aishell.representative-execution-contracts.v1');
assert.deepEqual(suite.arms.map(({ id }) => id), ['native', 'current-aishell-0.3.3', 'candidate']);
assert.deepEqual(suite.commonHostCatalog.capabilities, ['bounded-file-read', 'lexical-search', 'direct-process-launch', 'sha-guarded-file-edit']);
assert.match(suite.commonHostCatalog.rule, /identical across all three arms/u);
assert.deepEqual(suite.arms[0].aishellTools, []);
assert.deepEqual(suite.arms[1].aishellTools, ['run_check', 'artifact_read', 'workspace_snapshot', 'read_context', 'search_context']);
assert.deepEqual(suite.arms[2].aishellTools, ['run_check', 'run_observe', 'artifact_read', 'workspace_snapshot', 'workspace_wait', 'read_context', 'search_context', 'change_impact', 'apply_change_set']);
assert.ok(suite.arms.every(({ controls }, index) => index === 0 ? controls.length === 0 : controls.join(',') === 'runtime_status,runtime_open_manager'));
assert.ok(Number.isInteger(suite.repetitionsPerTask) && suite.repetitionsPerTask >= 3);
assert.ok(suite.tasks.length >= suite.minimumTaskCount && suite.minimumTaskCount >= 30);
assert.match(suite.promptTemplate, /\{task_id\}/u);
assert.match(suite.promptTemplate, /\{goal\}/u);
assert.match(suite.promptTemplate, /\{model_parameters\}/u);
assert.match(suite.promptTemplate, /\{agent_report_contract\}/u);
assert.equal(suite.metrics.primary, 'sum(total_model_tokens_across_all_attempts) / oracle_successes');
assert.equal(suite.metrics.missingUsage, 'invalid_run_not_zero');
assert.match(suite.oraclePolicy.attemptSolved, /external evaluator/u);
assert.match(suite.oraclePolicy.taskSolved, /all preregistered repetitions/u);
assert.match(suite.oraclePolicy.capabilityApplicability, /candidate must exercise/u);
assert.equal(suite.aggregation.regressionUnit, 'taskSolved');
assert.match(suite.aggregation.tokenNumerator, /including failed attempts/u);

const fixtureById = new Map(catalog.fixtures.map((fixture) => [fixture.id, fixture]));
assert.equal(fixtureById.size, catalog.fixtures.length, 'fixture id must be unique');
assert.equal(new Set(suite.tasks.map(({ id }) => id)).size, suite.tasks.length, 'task id must be unique');
assert.deepEqual(Object.keys(goals.goals).sort(), suite.tasks.map(({ id }) => id).sort(), 'goals must exactly cover frozen tasks');
assert.deepEqual(execution.contracts.map(({ taskId }) => taskId).sort(), suite.tasks.map(({ id }) => id).sort(), 'execution contracts must exactly cover frozen tasks');
assert.deepEqual(Object.keys(execution.candidateRequiredToolsByTask).sort(), suite.tasks.map(({ id }) => id).sort(), 'candidate tool requirements must exactly cover frozen tasks');
assert.deepEqual(Object.keys(execution.candidateRequiredActionsByTask).sort(), suite.tasks.map(({ id }) => id).sort(), 'candidate action requirements must exactly cover frozen tasks');
assert.deepEqual(Object.keys(execution.candidateRequestTemplateByTask).sort(), suite.tasks.map(({ id }) => id).sort(), 'candidate request templates must exactly cover frozen tasks');
const observerByKey = new Map();
for (const [source, keys] of Object.entries(execution.observerSources)) {
  for (const key of keys) {
    assert.equal(observerByKey.has(key), false, `observer key must be unique: ${key}`);
    observerByKey.set(key, source);
  }
}
for (const task of suite.tasks) {
  const fixture = fixtureById.get(task.fixture);
  assert.ok(fixture, `missing fixture: ${task.fixture}`);
  const scenario = fixture.scenarios[task.scenario];
  assert.ok(scenario, `missing scenario: ${task.fixture}/${task.scenario}`);
  assert.ok(scenario.oracle && Object.keys(scenario.oracle).length > 0,
    `oracle required: ${task.id}`);
  assert.ok(typeof goals.goals[task.id] === 'string' && goals.goals[task.id].length >= 40,
    `concrete goal required: ${task.id}`);
  const contract = execution.contracts.find(({ taskId }) => taskId === task.id);
  assert.ok(contract.setupSteps.length > 0 && contract.timedSteps.length > 0,
    `setup/timed steps required: ${task.id}`);
  for (const key of Object.keys(scenario.oracle)) {
    assert.ok(observerByKey.has(key), `observer source required: ${task.id}/${key}`);
  }
  assert.ok(execution.candidateRequiredToolsByTask[task.id].length > 0, `candidate tool trace required: ${task.id}`);
  assert.deepEqual(Object.keys(execution.candidateRequiredActionsByTask[task.id]).sort(), execution.candidateRequiredToolsByTask[task.id].sort(), `candidate actions must cover tools: ${task.id}`);
  assert.deepEqual(Object.keys(execution.candidateRequestTemplateByTask[task.id]).sort(), execution.candidateRequiredToolsByTask[task.id].sort(), `candidate request templates must cover tools: ${task.id}`);
  for (const tool of execution.candidateRequiredToolsByTask[task.id]) assert.ok(execution.candidateResultSchemaByTool[tool], `candidate result schema required: ${tool}`);
  if (execution.candidateExpectedErrorByTask[task.id]) {
    assert.equal(scenario.oracle.errorCode, execution.candidateExpectedErrorByTask[task.id], `expected error must bind oracle: ${task.id}`);
  }
  const renderedPrompt = await renderRepresentativePrompt(task.id);
  assert.match(renderedPrompt, /aishell\.agent-benchmark-report\.v1/u);
  assert.equal(renderedPrompt.includes('"oracle"'), false, `oracle values must remain hidden: ${task.id}`);
  for (const key of Object.keys(scenario.oracle).filter((key) => !suite.metrics.internalTelemetryKeys.includes(key))) {
    assert.ok(renderedPrompt.includes(`<observed ${key}>`), `report key must be model-visible: ${task.id}/${key}`);
  }
  assert.equal(renderedPrompt, await renderRepresentativePrompt(task.id), `samePrompt bytes must be arm-independent: ${task.id}`);
}
for (const fixture of catalog.fixtures) {
  if (fixture.generatedSeed) {
    assert.equal(generatedTreeDigest(fixture.generatedSeed), fixture.generatedSeed.expectedTreeDigest,
      `generated fixture bytes must be frozen: ${fixture.id}`);
  }
  const referenced = suite.tasks.filter((task) => task.fixture === fixture.id);
  assert.equal(referenced.length, Object.keys(fixture.scenarios).length,
    `all scenarios must be frozen as tasks: ${fixture.id}`);
}

process.stdout.write(`${JSON.stringify({
  schema: 'aishell.representative_suite_validation.v1',
  task_count: suite.tasks.length,
  fixture_count: catalog.fixtures.length,
  goal_count: Object.keys(goals.goals).length,
  arm_count: suite.arms.length,
  repetitions_per_task: suite.repetitionsPerTask,
  total_planned_attempts: suite.tasks.length * suite.arms.length * suite.repetitionsPerTask,
  status: 'valid',
})}\n`);
