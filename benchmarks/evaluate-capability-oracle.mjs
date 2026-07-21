#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { observeAttempt } from './observe-capability-attempt.mjs';
import { validateCapabilityObservation } from './validate-capability-observation.mjs';

const here = new URL('.', import.meta.url);

function subsetFailures(expected, actual, path = 'assertions') {
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual) || JSON.stringify(actual) !== JSON.stringify(expected)) {
      return [`${path}: expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`];
    }
    return [];
  }
  if (expected && typeof expected === 'object') {
    if (!actual || typeof actual !== 'object' || Array.isArray(actual)) {
      return [`${path}: expected object, received ${JSON.stringify(actual)}`];
    }
    return Object.entries(expected).flatMap(([key, value]) => subsetFailures(value, actual[key], `${path}.${key}`));
  }
  return Object.is(expected, actual) ? [] : [`${path}: expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`];
}

export async function evaluateAttempt({ taskId, armId, actual }) {
  validateCapabilityObservation(actual);
  const suite = JSON.parse(await readFile(new URL('representative-suite.v1.json', here)));
  const catalog = JSON.parse(await readFile(new URL('capability-fixtures.v1.json', here)));
  const execution = JSON.parse(await readFile(new URL('representative-execution-contracts.v1.json', here)));
  const task = suite.tasks.find(({ id }) => id === taskId);
  const arm = suite.arms.find(({ id }) => id === armId);
  if (!task) throw new Error(`unknown task: ${taskId}`);
  if (!arm) throw new Error(`unknown arm: ${armId}`);
  const fixture = catalog.fixtures.find(({ id }) => id === task.fixture);
  const expected = fixture.scenarios[task.scenario].oracle;
  const internal = new Set(suite.metrics.internalTelemetryKeys);
  const applicable = armId !== 'candidate'
    ? Object.fromEntries(Object.entries(expected).filter(([key]) => !internal.has(key)))
    : expected;
  const failures = [];
  if (actual?.producer !== 'aishell-benchmark-observer.v1') failures.push('producer: benchmark observer evidence required');
  if (actual?.taskId !== taskId) failures.push(`taskId: expected ${taskId}`);
  if (actual?.arm !== armId) failures.push(`arm: expected ${armId}`);
  if (actual?.agent?.exitCode !== 0) failures.push(`agent.exitCode: expected 0, received ${JSON.stringify(actual?.agent?.exitCode)}`);
  if (actual?.agent?.timedOut !== false) failures.push(`agent.timedOut: expected false, received ${JSON.stringify(actual?.agent?.timedOut)}`);
  failures.push(...subsetFailures(applicable, actual?.assertions));
  const sourceForKey = new Map(Object.entries(execution.observerSources).flatMap(([source, keys]) =>
    keys.map((key) => [key, source])));
  for (const key of Object.keys(applicable)) {
    if (actual?.observationSources?.[key] !== sourceForKey.get(key)) {
      failures.push(`observationSources.${key}: expected ${JSON.stringify(sourceForKey.get(key))}, received ${JSON.stringify(actual?.observationSources?.[key])}`);
    }
  }
  const functional = Object.fromEntries(Object.entries(applicable).filter(([key]) => !internal.has(key)));
  failures.push(...subsetFailures(functional, actual.agentReport.assertions, 'agentReport.assertions'));
  if (armId === 'candidate') {
    const toolBound = Object.fromEntries(Object.entries(functional).filter(([key]) => !execution.toolResultProjection.exemptKeys.includes(key)));
    failures.push(...subsetFailures(toolBound, actual.toolResultAssertions, 'toolResultAssertions'));
  }
  const frozenRequired = Object.entries(execution.candidateRequiredActionsByTask[taskId])
    .map(([tool, action]) => `${tool}:${action}`).sort();
  if (JSON.stringify(actual.capabilityEvidence.requiredInvocations) !== JSON.stringify(frozenRequired)) {
    failures.push('capabilityEvidence.requiredInvocations: frozen contract mismatch');
  }
  if (armId === 'candidate') {
    for (const invocation of frozenRequired) {
      if (!actual.capabilityEvidence.acceptedInvocations.includes(invocation)) failures.push(`capabilityEvidence: required accepted outcome missing: ${invocation}`);
    }
  }
  return {
    schema: 'aishell.capability-oracle-result.v1',
    taskId,
    arm: armId,
    solved: failures.length === 0,
    failures,
  };
}

async function main() {
  const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, value, index, values) => {
    if (value.startsWith('--')) pairs.push([value.slice(2), values[index + 1]]);
    return pairs;
  }, []));
  if (!args.task || !args.arm || !args.workspace) {
    throw new Error('usage: evaluate-capability-oracle.mjs --task <task-id> --arm <arm-id> --workspace <dir> --pre-attempt <manifest.json> --setup-evidence <json> --request-contract <json> [--baseline <json>] [--result <json>] [--process <json>] [--artifact-store <dir>] [--telemetry <json>] [--trace <json>] [--tool-trace <json>] [--agent-report <json>]');
  }
  const actual = await observeAttempt({
    taskId:args.task, armId:args.arm, workspace:args.workspace, baselineFile:args.baseline,
    resultFile:args.result, processFile:args.process, artifactStore:args['artifact-store'], telemetryFile:args.telemetry, traceFile:args.trace, toolTraceFile:args['tool-trace'], agentReportFile:args['agent-report'], preAttemptFile:args['pre-attempt'], setupEvidenceFile:args['setup-evidence'], requestContractFile:args['request-contract'],
  });
  const result = await evaluateAttempt({ taskId: args.task, armId: args.arm, actual });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (!result.solved) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
