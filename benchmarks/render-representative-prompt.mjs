#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const here = new URL('.', import.meta.url);

export async function renderRepresentativePrompt(taskId) {
  const suite = JSON.parse(await readFile(new URL('representative-suite.v1.json', here)));
  const catalog = JSON.parse(await readFile(new URL('capability-fixtures.v1.json', here)));
  const goals = JSON.parse(await readFile(new URL('representative-task-goals.v1.json', here)));
  const execution = JSON.parse(await readFile(new URL('representative-execution-contracts.v1.json', here)));
  const task = suite.tasks.find(({id}) => id === taskId);
  if (!task) throw new Error('unknown task');
  const oracle = catalog.fixtures.find(({id}) => id === task.fixture).scenarios[task.scenario].oracle;
  const internal = new Set(suite.metrics.internalTelemetryKeys);
  const assertionKeys = Object.keys(oracle).filter((key) => !internal.has(key)).sort();
  const reportContract = {schema:'aishell.agent-benchmark-report.v1',taskId,
    assertions:Object.fromEntries(assertionKeys.map((key) => [key, `<observed ${key}>`]))};
  return suite.promptTemplate
    .replace('{task_id}', taskId)
    .replace('{goal}', goals.goals[taskId])
    .replace('{model_parameters}', execution.modelParameters[taskId] ?? execution.modelParameters.default)
    .replace('{agent_report_contract}', JSON.stringify(reportContract));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.length !== 3) throw new Error('usage: render-representative-prompt.mjs <task-id>');
  process.stdout.write(`${await renderRepresentativePrompt(process.argv[2])}\n`);
}
