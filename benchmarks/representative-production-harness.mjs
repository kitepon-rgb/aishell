#!/usr/bin/env node

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { captureManifest } from './capture-workspace-manifest.mjs';
import { evaluateAttempt } from './evaluate-capability-oracle.mjs';
import { materializeRequestContract } from './materialize-capability-request.mjs';
import { observeAttempt as observeCapabilityAttempt } from './observe-capability-attempt.mjs';
import { createPhase3CodexExecutor } from './phase3-codex-executor.mjs';
import { mcpCatalogRequestBytes, validateCatalogExchange } from './phase3-production-harness.mjs';
import { canonicalJSONBytes } from './production-v2-benchmark-adapter.mjs';
import { runRepresentativeAttempts } from './representative-production-runner.mjs';

const here = new URL('.', import.meta.url);

function requiredFunction(value, label) {
  if (typeof value !== 'function') throw new Error(`${label} callback is required`);
  return value;
}

function exactBytes(value, label) {
  if (!Buffer.isBuffer(value) && !ArrayBuffer.isView(value)) throw new Error(`${label} bytes are required`);
  return Buffer.from(value);
}

async function exclusiveJSON(file, value) {
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
  return file;
}

async function frozenInputs() {
  const [suite, catalog, execution] = await Promise.all([
    readFile(new URL('representative-suite.v1.json', here), 'utf8').then(JSON.parse),
    readFile(new URL('capability-fixtures.v1.json', here), 'utf8').then(JSON.parse),
    readFile(new URL('representative-execution-contracts.v1.json', here), 'utf8').then(JSON.parse),
  ]);
  return { suite, catalog, execution };
}

export function createRepresentativeProductionHarness(options) {
  const prepareSetup = requiredFunction(options.prepareSetup, 'prepareSetup');
  const materializeLocalPrompt = requiredFunction(options.materializePrompt, 'materializePrompt');
  const beforeLocalAttempt = requiredFunction(options.beforeAgentAttempt, 'beforeAgentAttempt');
  const afterLocalAttempt = requiredFunction(options.afterAgentAttempt, 'afterAgentAttempt');
  const exchangeMCP = requiredFunction(options.exchangeMCP, 'exchangeMCP');
  const collectEvidence = requiredFunction(options.collectAttemptEvidence, 'collectAttemptEvidence');
  const validateSetupEvidence = options.validateSetupEvidence === undefined
    ? (async () => {}) : requiredFunction(options.validateSetupEvidence, 'validateSetupEvidence');
  const observeProviderModel = requiredFunction(options.observeProviderModel, 'observeProviderModel');
  const runProcess = requiredFunction(options.runProcess, 'runProcess');
  const setupStates = new Map();
  const oracleRecords = new Map((options.priorOracleRecords ?? []).map((record) => [record.sequence, record]));
  const metricRecords = new Map((options.priorMetricRecords ?? []).map((record) => [record.sequence, record]));
  const frozenPromise = frozenInputs();

  const setupAttempt = async (input) => {
    const prepared = await prepareSetup(input);
    if (!prepared || typeof prepared !== 'object' || !prepared.fields || !prepared.trustedProductionSetup
      || !Array.isArray(prepared.stepEvidence) || !Array.isArray(prepared.deferred)
      || typeof prepared.artifactStore !== 'string') {
      throw new Error(`representative setup is incomplete: ${input.attempt.attemptID}`);
    }
    const preState = await captureManifest(input.workspace);
    const benchmarkSetupEvidence = {
      schema: 'aishell.benchmark-setup-evidence.v1',
      taskId: input.attempt.taskID,
      workspaceRoot: input.workspace,
      preStateDigest: preState.digest,
      ...prepared.fields,
    };
    await validateSetupEvidence({
      attempt: input.attempt,
      workspace: input.workspace,
      baselineManifest: input.baselineManifest,
      preAttemptManifest: preState,
      setupEvidence: benchmarkSetupEvidence,
    });
    setupStates.set(input.attempt.attemptID, { prepared: structuredClone(prepared), benchmarkSetupEvidence });
    return benchmarkSetupEvidence;
  };

  const observeToolCatalog = async ({ binary, profile, stateDirectory, workspace }) => {
    const requestBytes = mcpCatalogRequestBytes();
    const responseBytes = exactBytes(await exchangeMCP({ binary, profile, stateDirectory, workspace, requestBytes }), 'catalog response');
    const observation = validateCatalogExchange(requestBytes, responseBytes);
    await writeFile(path.join(stateDirectory, 'benchmark-mcp-catalog-request.jsonl'), observation.requestBytes, { flag: 'wx' });
    await writeFile(path.join(stateDirectory, 'benchmark-mcp-catalog-response.jsonl'), observation.responseBytes, { flag: 'wx' });
    return observation.responseSHA256;
  };

  const materializePrompt = async ({ attempt, prompt, ...rest }) => {
    const state = setupStates.get(attempt.attemptID);
    if (!state) throw new Error(`prompt setup state is missing: ${attempt.attemptID}`);
    return materializeLocalPrompt({ attempt, prompt, ...rest, setup: structuredClone(state.prepared) });
  };

  const beforeAgentAttempt = async ({ attempt, ...rest }) => {
    const state = setupStates.get(attempt.attemptID);
    if (!state) throw new Error(`pre-agent setup state is missing: ${attempt.attemptID}`);
    return beforeLocalAttempt({ attempt, ...rest, setup: structuredClone(state.prepared) });
  };

  const afterAgentAttempt = async ({ attempt, ...rest }) => {
    const state = setupStates.get(attempt.attemptID);
    if (!state) throw new Error(`post-agent setup state is missing: ${attempt.attemptID}`);
    return afterLocalAttempt({ attempt, ...rest, setup: structuredClone(state.prepared) });
  };

  const observeAttempt = async (input) => {
    const { attempt, workspace, stateDirectory, runDirectory, baselineManifest, preAttemptManifest,
      setup, events, toolTrace, finalAgent, execution, mcpWireDirectory } = input;
    const state = setupStates.get(attempt.attemptID);
    if (!state || !canonicalJSONBytes(setup).equals(canonicalJSONBytes(state.benchmarkSetupEvidence))) {
      throw new Error(`observer setup state is missing: ${attempt.attemptID}`);
    }
    const raw = await collectEvidence({
      attempt, workspace, stateDirectory, runDirectory, baselineManifest, preAttemptManifest,
      benchmarkSetupEvidence: state.benchmarkSetupEvidence,
      trustedProductionSetup: state.prepared.trustedProductionSetup,
      setupStepEvidence: state.prepared.stepEvidence,
      artifactStore: state.prepared.artifactStore,
      agentEvents: events, rawToolTrace: toolTrace, finalAgent, execution, mcpWireDirectory,
    });
    const files = {
      baseline: path.join(runDirectory, 'baseline-manifest.json'),
      preAttempt: path.join(runDirectory, 'pre-attempt-manifest.json'),
      setup: path.join(runDirectory, 'setup-evidence.json'),
      request: path.join(runDirectory, 'observer-request-contract.json'),
      result: await exclusiveJSON(path.join(runDirectory, 'observer-structured-result.json'), raw.result),
      process: await exclusiveJSON(path.join(runDirectory, 'observer-process.json'), raw.process),
      telemetry: await exclusiveJSON(path.join(runDirectory, 'observer-telemetry.json'), raw.telemetry),
      trace: await exclusiveJSON(path.join(runDirectory, 'observer-continuation-trace.json'), raw.trace),
      toolTrace: await exclusiveJSON(path.join(runDirectory, 'observer-tool-trace.json'), raw.toolTrace),
      agentReport: await exclusiveJSON(path.join(runDirectory, 'observer-agent-report.json'), finalAgent),
    };
    const frozen = await frozenPromise;
    const requestContract = materializeRequestContract({
      taskId: attempt.taskID, workspaceRoot: workspace, preAttemptManifest, baselineManifest,
      setupEvidence: state.benchmarkSetupEvidence, ...frozen,
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
    oracleRecords.set(attempt.sequence, { sequence: attempt.sequence, result: oracle });
    metricRecords.set(attempt.sequence, { sequence: attempt.sequence, metrics: raw.metrics });
    setupStates.delete(attempt.attemptID);
    return {
      observerEvidence,
      adapterTraceBytes: raw.adapterTraceBytes == null ? null : exactBytes(raw.adapterTraceBytes, 'adapter trace'),
    };
  };

  const executor = createPhase3CodexExecutor({
    ...options.executorOptions,
    setupAttempt, observeToolCatalog, materializePrompt, beforeAgentAttempt, afterAgentAttempt,
    observeProviderModel, observeAttempt, runProcess,
  });

  const run = async ({ manifest, priorRecords = [], onCheckpoint = async () => {} }) => {
    await mkdir(options.executorOptions.outputDirectory, { recursive: true });
    const result = await runRepresentativeAttempts({
      manifest, executeAttempt: executor, priorRecords,
      onRecord: async (record, completed) => {
        await onCheckpoint({
          record, completed,
          records: undefined,
          oracleRecords: [...oracleRecords.values()].sort((a, b) => a.sequence - b.sequence),
          metricRecords: [...metricRecords.values()].sort((a, b) => a.sequence - b.sequence),
        });
      },
    });
    return {
      result,
      oracleRecords: [...oracleRecords.values()].sort((a, b) => a.sequence - b.sequence),
      metricRecords: [...metricRecords.values()].sort((a, b) => a.sequence - b.sequence),
    };
  };

  return Object.freeze({ run, executor });
}
