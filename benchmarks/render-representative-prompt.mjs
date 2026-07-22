#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const here = new URL('.', import.meta.url);
export const REPRESENTATIVE_OPAQUE_BINDINGS_TOKEN = '{{AISHELL_VERIFIED_OPAQUE_SETUP_BINDINGS}}';

export function representativeJSONType(value) {
  if (Array.isArray(value)) {
    const itemTypes = [...new Set(value.map(representativeJSONType))];
    return itemTypes.length === 1 ? `array<${itemTypes[0]}>` : 'array';
  }
  if (value === null) return 'null';
  if (typeof value === 'number' && Number.isFinite(value)) return 'number';
  if (typeof value === 'boolean') return 'boolean';
  if (typeof value === 'string') return 'string';
  if (value && typeof value === 'object') return 'object';
  throw new Error('unsupported representative oracle value type');
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function materializedModelParameters(taskId, fixture, configured) {
  if (taskId.startsWith('artifact-query-')) {
    return `${configured} Verified opaque setup bindings: ${REPRESENTATIVE_OPAQUE_BINDINGS_TOKEN}.`;
  }
  if (!['change-set-atomic-success', 'change-set-stale-sha', 'bilingual-workflow-japanese'].includes(taskId)) {
    return configured;
  }
  const bindings = ['src/a.txt', 'src/b.txt'].map((path) => {
    const content = fixture.seedFiles[path];
    if (typeof content !== 'string') throw new Error(`model parameter source is missing: ${taskId}.${path}`);
    return `${path}=${sha256(Buffer.from(content, 'utf8'))}`;
  });
  return `${configured} Frozen pre-state SHA-256 bindings: ${bindings.join(', ')}.`;
}

export async function renderRepresentativePrompt(taskId, { materializeModelParameters = false } = {}) {
  const suite = JSON.parse(await readFile(new URL('representative-suite.v1.json', here)));
  const catalog = JSON.parse(await readFile(new URL('capability-fixtures.v1.json', here)));
  const goals = JSON.parse(await readFile(new URL('representative-task-goals.v1.json', here)));
  const execution = JSON.parse(await readFile(new URL('representative-execution-contracts.v1.json', here)));
  const task = suite.tasks.find(({id}) => id === taskId);
  if (!task) throw new Error('unknown task');
  const fixture = catalog.fixtures.find(({id}) => id === task.fixture);
  const oracle = fixture.scenarios[task.scenario].oracle;
  const internal = new Set(suite.metrics.internalTelemetryKeys);
  const assertionKeys = Object.keys(oracle).filter((key) => !internal.has(key)).sort();
  const reportContract = {schema:'aishell.agent-benchmark-report.v1',taskId,
    assertions:Object.fromEntries(assertionKeys.map((key) => [key, `<observed ${key}>`]))};
  const typeContract = assertionKeys.map((key) => `${key}=${representativeJSONType(oracle[key])}`).join(', ');
  const assertionGuidance = assertionKeys.length === 0
    ? ' This task has no model-reported assertion values; return assertions as an empty JSON object.'
    : ` Required JSON types for assertion values: ${typeContract}. The quoted <observed ...> tokens mark value locations only; replace each token with the observed value encoded in its required JSON type.`;
  return suite.promptTemplate
    .replace('{task_id}', taskId)
    .replace('{goal}', goals.goals[taskId])
    .replace('{model_parameters}', materializeModelParameters
      ? materializedModelParameters(taskId, fixture, execution.modelParameters[taskId] ?? execution.modelParameters.default)
      : execution.modelParameters[taskId] ?? execution.modelParameters.default)
    .replace('{agent_report_contract}', `${JSON.stringify(reportContract)}${assertionGuidance}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.length !== 3) throw new Error('usage: render-representative-prompt.mjs <task-id>');
  process.stdout.write(`${await renderRepresentativePrompt(process.argv[2])}\n`);
}
