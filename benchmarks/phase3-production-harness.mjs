#!/usr/bin/env node

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { aggregatePhase3Acceptance } from './phase3-acceptance-aggregate.mjs';
import { runPhase3CodexBenchmark } from './phase3-codex-executor.mjs';
import { evaluateAttempt } from './evaluate-capability-oracle.mjs';
import { materializeRequestContract } from './materialize-capability-request.mjs';
import { generatedSeedEntries } from './materialize-generated-seed.mjs';
import { observeAttempt as observeCapabilityAttempt } from './observe-capability-attempt.mjs';
import { canonicalJSONBytes, sha256Hex } from './production-v2-benchmark-adapter.mjs';
import { captureManifest } from './capture-workspace-manifest.mjs';

const here = new URL('.', import.meta.url);
const SETUP_ACTIONS = new Set([
  'execute the check once and retain its freshness inputs',
  'index static imports',
]);
const METRIC_KEYS = Object.freeze([
  'firstUsefulResultMilliseconds', 'toolCalls', 'modelTurns', 'retries', 'artifactRereads',
  'filesystemEntriesRescanned', 'bytesReread', 'processReexecutions', 'cacheHits',
  'changeJournalHits', 'toolAdoption',
]);

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value, required, label) {
  if (!plainObject(value)) throw new Error(`${label} must be an object`);
  const actual = Object.keys(value).sort();
  const expected = [...required].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${label} has invalid fields`);
  }
}

function requiredCallback(value, label) {
  if (typeof value !== 'function') throw new Error(`${label} callback is required`);
  return value;
}

function absolute(value, label) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || value.includes('\0') || path.normalize(value) !== value) {
    throw new Error(`${label} must be a normalized absolute path`);
  }
  return value;
}

async function frozenInputs() {
  const [suite, catalog, execution] = await Promise.all([
    readFile(new URL('representative-suite.v1.json', here), 'utf8').then(JSON.parse),
    readFile(new URL('capability-fixtures.v1.json', here), 'utf8').then(JSON.parse),
    readFile(new URL('representative-execution-contracts.v1.json', here), 'utf8').then(JSON.parse),
  ]);
  return { suite, catalog, execution };
}

async function exclusiveJSON(file, value) {
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
  return file;
}

async function verifyMaterializedSeed(workspace, fixture) {
  const entries = [
    ...Object.entries(fixture.seedFiles),
    ...(fixture.generatedSeed ? generatedSeedEntries(fixture.generatedSeed).map(({ path: relative, bytes }) => [relative, bytes]) : []),
  ];
  const seen = new Set();
  for (const [relative, content] of entries) {
    if (seen.has(relative)) throw new Error(`frozen seed contains a duplicate path: ${relative}`);
    seen.add(relative);
    const file = path.resolve(workspace, relative);
    if (file !== workspace && !file.startsWith(`${workspace}${path.sep}`)) throw new Error('frozen seed escapes workspace');
    const actual = await readFile(file);
    if (!actual.equals(Buffer.from(content))) throw new Error(`materialized seed differs from frozen bytes: ${relative}`);
  }
}

function exactBytes(value, label) {
  if (!Buffer.isBuffer(value) && !ArrayBuffer.isView(value)) throw new Error(`${label} exact bytes are required`);
  return Buffer.from(value);
}

function parseJSONLines(bytes, label) {
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { throw new Error(`${label} must be UTF-8 JSONL`); }
  return text.split('\n').filter(Boolean).map((line, index) => {
    try {
      const value = JSON.parse(line);
      if (!plainObject(value)) throw new Error();
      return value;
    } catch { throw new Error(`${label} line ${index + 1} is not a JSON object`); }
  });
}

export function mcpCatalogRequestBytes() {
  const requests = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: {
      protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'aishell-phase3-benchmark', version: '1' },
    } },
    { jsonrpc: '2.0', method: 'notifications/initialized', params: {} },
    { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
  ];
  return Buffer.concat(requests.map((request) => Buffer.concat([canonicalJSONBytes(request), Buffer.from('\n')])));
}

export function validateCatalogExchange(requestBytes, responseBytes) {
  const request = exactBytes(requestBytes, 'MCP catalog request');
  const response = exactBytes(responseBytes, 'MCP catalog response');
  if (!request.equals(mcpCatalogRequestBytes())) throw new Error('MCP catalog request bytes differ from the frozen exchange');
  const messages = parseJSONLines(response, 'MCP catalog response');
  const initialize = messages.filter(({ id }) => id === 1);
  const toolsList = messages.filter(({ id }) => id === 2);
  if (initialize.length !== 1 || toolsList.length !== 1
    || initialize[0].jsonrpc !== '2.0' || initialize[0].error !== undefined
    || initialize[0].result?.protocolVersion !== '2025-11-25'
    || toolsList[0].jsonrpc !== '2.0' || toolsList[0].error !== undefined
    || !Array.isArray(toolsList[0].result?.tools)) {
    throw new Error('MCP initialize/tools/list response is invalid');
  }
  return {
    requestBytes: request,
    requestSHA256: sha256Hex(request),
    responseBytes: response,
    responseSHA256: sha256Hex(response),
  };
}

function validateMetrics(metrics) {
  exactKeys(metrics, METRIC_KEYS, 'observer metrics');
  for (const key of METRIC_KEYS) {
    const value = metrics[key];
    if (key === 'firstUsefulResultMilliseconds') {
      if (value !== null && (!Number.isSafeInteger(value) || value < 0)) throw new Error(`${key} is invalid`);
    } else if (key === 'toolAdoption') {
      if (typeof value !== 'boolean') throw new Error('toolAdoption is invalid');
    } else if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${key} is invalid`);
  }
}

/**
 * Bind the production-specific operations required by phase3-codex-executor.
 * No callback has a default: the caller must provide every stateful boundary explicitly.
 */
export function createPhase3ProductionHarness(options) {
  if (!plainObject(options)) throw new Error('production harness options are required');
  const runSetupStep = requiredCallback(options.runSetupStep, 'runSetupStep');
  const captureTrustedSetup = requiredCallback(options.captureTrustedSetup, 'captureTrustedSetup');
  const exchangeMCP = requiredCallback(options.exchangeMCP, 'exchangeMCP');
  const collectAttemptEvidence = requiredCallback(options.collectAttemptEvidence, 'collectAttemptEvidence');
  const observeProviderModel = requiredCallback(options.observeProviderModel, 'observeProviderModel');
  const runProcess = requiredCallback(options.runProcess, 'runProcess');
  const setupStates = new Map();
  const oracleRecords = new Map();
  const observerMetricRecords = new Map();
  const executorEvidenceRecords = new Map();
  const catalogObservations = new Map();
  let consumed = false;

  const setupAttempt = async ({ attempt, armBinding, workspace, stateDirectory, frozen, baselineManifest, applyFrozenMutation }) => {
    if (setupStates.has(attempt.attemptID)) throw new Error(`setup attempt repeated: ${attempt.attemptID}`);
    absolute(workspace, 'workspace');
    await verifyMaterializedSeed(workspace, frozen.fixture);
    if (!Array.isArray(frozen.contract?.setupSteps) || frozen.contract.setupSteps[0] !== 'materialize fixture') {
      throw new Error(`frozen setup steps are invalid: ${attempt.taskID}`);
    }
    const stepEvidence = [];
    let mutationApplied = false;
    for (const [index, step] of frozen.contract.setupSteps.entries()) {
      if (index === 0) {
        stepEvidence.push({ step, status: 'verified' });
      } else if (step.startsWith('apply the frozen ')) {
        if (mutationApplied) throw new Error(`frozen mutation step repeated: ${attempt.taskID}`);
        await applyFrozenMutation();
        mutationApplied = true;
        stepEvidence.push({ step, status: 'applied' });
      } else if (SETUP_ACTIONS.has(step)) {
        const evidence = await runSetupStep(Object.freeze({
          attempt: structuredClone(attempt), armBinding: structuredClone(armBinding), workspace, stateDirectory, step,
        }));
        if (!plainObject(evidence)) throw new Error(`setup step evidence is missing: ${step}`);
        stepEvidence.push({ step, status: 'completed', evidence: structuredClone(evidence) });
      } else {
        throw new Error(`unsupported frozen setup step: ${step}`);
      }
    }
    if (!mutationApplied) {
      await applyFrozenMutation();
      mutationApplied = true;
    }
    const trustedProductionSetup = await captureTrustedSetup(Object.freeze({
      attempt: structuredClone(attempt), armBinding: structuredClone(armBinding), workspace, stateDirectory,
      frozen: structuredClone(frozen), baselineManifest: structuredClone(baselineManifest),
      stepEvidence: structuredClone(stepEvidence),
    }));
    if (!plainObject(trustedProductionSetup)) throw new Error('trusted production setup is missing');
    const preState = await captureManifest(workspace);
    const benchmarkSetupEvidence = {
      schema: 'aishell.benchmark-setup-evidence.v1', taskId: attempt.taskID,
      workspaceRoot: workspace, preStateDigest: preState.digest,
    };
    setupStates.set(attempt.attemptID, {
      benchmarkSetupEvidence: structuredClone(benchmarkSetupEvidence),
      trustedProductionSetup: structuredClone(trustedProductionSetup),
      stepEvidence: structuredClone(stepEvidence),
    });
    return benchmarkSetupEvidence;
  };

  const observeToolCatalog = async ({ binary, profile, stateDirectory, workspace }) => {
    const requestBytes = mcpCatalogRequestBytes();
    const responseBytes = exactBytes(await exchangeMCP(Object.freeze({
      binary, profile, stateDirectory, workspace, requestBytes: Buffer.from(requestBytes),
    })), 'MCP catalog response');
    const observation = validateCatalogExchange(requestBytes, responseBytes);
    const key = `${workspace}\0${profile}`;
    if (catalogObservations.has(key)) throw new Error('tool catalog observed more than once for an attempt');
    catalogObservations.set(key, observation);
    await writeFile(path.join(stateDirectory, 'benchmark-mcp-catalog-request.jsonl'), observation.requestBytes, { flag: 'wx' });
    await writeFile(path.join(stateDirectory, 'benchmark-mcp-catalog-response.jsonl'), observation.responseBytes, { flag: 'wx' });
    await exclusiveJSON(path.join(stateDirectory, 'benchmark-mcp-catalog-binding.json'), {
      requestSHA256: observation.requestSHA256, responseSHA256: observation.responseSHA256,
    });
    return observation.responseSHA256;
  };

  const observeAttempt = async (input) => {
    const { attempt, workspace, stateDirectory, runDirectory, mcpWireDirectory, baselineManifest, preAttemptManifest, setup, events,
      toolTrace, finalAgent, execution } = input;
    const setupState = setupStates.get(attempt.attemptID);
    if (!setupState || canonicalJSONBytes(setup).toString('hex') !== canonicalJSONBytes(setupState.benchmarkSetupEvidence).toString('hex')) {
      throw new Error(`attempt setup binding is missing: ${attempt.attemptID}`);
    }
    const raw = await collectAttemptEvidence(Object.freeze({
      attempt: structuredClone(attempt), workspace, stateDirectory, runDirectory, mcpWireDirectory,
      baselineManifest: structuredClone(baselineManifest), preAttemptManifest: structuredClone(preAttemptManifest),
      benchmarkSetupEvidence: structuredClone(setupState.benchmarkSetupEvidence),
      trustedProductionSetup: structuredClone(setupState.trustedProductionSetup),
      setupStepEvidence: structuredClone(setupState.stepEvidence),
      agentEvents: structuredClone(events), rawToolTrace: structuredClone(toolTrace),
      finalAgent: structuredClone(finalAgent), execution: structuredClone(execution),
    }));
    exactKeys(raw, ['result', 'process', 'artifactStore', 'telemetry', 'trace', 'toolTrace', 'metrics', 'adapterTraceBytes'], 'attempt evidence');
    for (const key of ['result', 'process', 'telemetry', 'trace', 'toolTrace']) {
      if (!plainObject(raw[key])) throw new Error(`attempt evidence ${key} is missing`);
    }
    absolute(raw.artifactStore, 'artifactStore');
    validateMetrics(raw.metrics);
    if (!Array.isArray(raw.toolTrace.events)) throw new Error('observer tool trace events are missing');
    const processEvidence = { ...raw.process, agentExitCode: execution.exitCode, agentTimedOut: execution.timedOut };
    const files = {
      baseline: path.join(runDirectory, 'baseline-manifest.json'),
      preAttempt: path.join(runDirectory, 'pre-attempt-manifest.json'),
      setup: path.join(runDirectory, 'setup-evidence.json'),
      request: path.join(runDirectory, 'observer-request-contract.json'),
      result: await exclusiveJSON(path.join(runDirectory, 'observer-structured-result.json'), raw.result),
      process: await exclusiveJSON(path.join(runDirectory, 'observer-process.json'), processEvidence),
      telemetry: await exclusiveJSON(path.join(runDirectory, 'observer-telemetry.json'), raw.telemetry),
      trace: await exclusiveJSON(path.join(runDirectory, 'observer-continuation-trace.json'), raw.trace),
      toolTrace: await exclusiveJSON(path.join(runDirectory, 'observer-tool-trace.json'), raw.toolTrace),
      agentReport: await exclusiveJSON(path.join(runDirectory, 'observer-agent-report.json'), finalAgent),
    };
    const frozen = await frozenInputs();
    const requestContract = materializeRequestContract({
      taskId: attempt.taskID, workspaceRoot: workspace, preAttemptManifest, baselineManifest,
      setupEvidence: setupState.benchmarkSetupEvidence,
      suite: frozen.suite, catalog: frozen.catalog, execution: frozen.execution,
    });
    await exclusiveJSON(files.request, requestContract);
    const observerEvidence = await observeCapabilityAttempt({
      taskId: attempt.taskID, armId: attempt.arm, workspace,
      baselineFile: files.baseline, preAttemptFile: files.preAttempt, setupEvidenceFile: files.setup,
      requestContractFile: files.request, resultFile: files.result, processFile: files.process,
      artifactStore: raw.artifactStore, telemetryFile: files.telemetry, traceFile: files.trace,
      toolTraceFile: files.toolTrace, agentReportFile: files.agentReport,
    });
    const oracle = await evaluateAttempt({ taskId: attempt.taskID, armId: attempt.arm, actual: observerEvidence });
    if (oracleRecords.has(attempt.sequence)) throw new Error(`oracle sequence repeated: ${attempt.sequence}`);
    oracleRecords.set(attempt.sequence, { sequence: attempt.sequence, result: oracle });
    observerMetricRecords.set(attempt.sequence, { sequence: attempt.sequence, metrics: structuredClone(raw.metrics) });
    executorEvidenceRecords.set(attempt.sequence, { sequence: attempt.sequence, status: 'completed', failure: null });
    return { observerEvidence, adapterTraceBytes: raw.adapterTraceBytes == null ? null : exactBytes(raw.adapterTraceBytes, 'adapter trace') };
  };

  const executorOptions = {
    ...options.executorOptions,
    setupAttempt,
    observeToolCatalog,
    observeProviderModel,
    observeAttempt,
    runProcess,
  };

  const run = async ({ manifest }) => {
    if (consumed) throw new Error('production harness instance may run only once');
    consumed = true;
    const result = await runPhase3CodexBenchmark({ manifest, executorOptions });
    const ordered = (map, label) => {
      if (map.size !== manifest.attempts.length) throw new Error(`${label} records are incomplete`);
      return [...map.values()].sort((left, right) => left.sequence - right.sequence);
    };
    const oracle = ordered(oracleRecords, 'oracle');
    const metrics = ordered(observerMetricRecords, 'observer metric');
    const executions = ordered(executorEvidenceRecords, 'executor evidence');
    const report = aggregatePhase3Acceptance({
      manifest, result, oracleRecords: oracle,
      observerMetricRecords: metrics, executorEvidenceRecords: executions,
    });
    return {
      result, oracleRecords: oracle, observerMetricRecords: metrics,
      executorEvidenceRecords: executions, report,
    };
  };

  return Object.freeze({ run, callbacks: Object.freeze({ setupAttempt, observeToolCatalog, observeAttempt, observeProviderModel }), executorOptions });
}

export async function runPhase3ProductionHarness({ manifest, options }) {
  return createPhase3ProductionHarness(options).run({ manifest });
}

async function main() {
  const configFile = process.argv[2];
  if (!configFile) throw new Error('usage: phase3-production-harness.mjs <configuration.json>');
  const configuration = JSON.parse(await readFile(configFile, 'utf8'));
  exactKeys(configuration, ['manifestFile', 'callbacksModule', 'executorOptions'], 'harness configuration');
  const manifestFile = absolute(path.resolve(path.dirname(configFile), configuration.manifestFile), 'manifestFile');
  const callbackFile = absolute(path.resolve(path.dirname(configFile), configuration.callbacksModule), 'callbacksModule');
  const [manifest, callbacks] = await Promise.all([
    readFile(manifestFile, 'utf8').then(JSON.parse),
    import(pathToFileURL(callbackFile).href),
  ]);
  const outcome = await runPhase3ProductionHarness({
    manifest,
    options: {
      executorOptions: configuration.executorOptions,
      runSetupStep: callbacks.runSetupStep,
      captureTrustedSetup: callbacks.captureTrustedSetup,
      exchangeMCP: callbacks.exchangeMCP,
      collectAttemptEvidence: callbacks.collectAttemptEvidence,
      observeProviderModel: callbacks.observeProviderModel,
      runProcess: callbacks.runProcess,
    },
  });
  process.stdout.write(`${JSON.stringify(outcome, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
