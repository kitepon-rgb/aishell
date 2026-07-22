#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import {
  adaptFrozenCapabilityRequest,
  buildBenchmarkTrace,
  canonicalJSONBytes,
  projectProductionV2Result,
  sha256Hex,
} from './production-v2-benchmark-adapter.mjs';
import { materializeRequestContract } from './materialize-capability-request.mjs';
import { renderRepresentativePrompt } from './render-representative-prompt.mjs';

const here = new URL('.', import.meta.url);
const PHASE3_TASKS = Object.freeze([
  'freshness-cache-repeat-check',
  'freshness-cache-input-change',
  'change-impact-direct-dependent',
  'change-impact-unresolved-edge',
  'focused-pipeline-recommend-only',
  'focused-pipeline-explicit-run',
]);
const ARMS = Object.freeze(['native', 'current-aishell-0.3.3', 'candidate']);
const SHA256 = /^[a-f0-9]{64}$/u;
const PHASE3_FIXTURES = Object.freeze({
  'freshness-cache-repeat-check': 'freshness-cache',
  'freshness-cache-input-change': 'freshness-cache',
  'change-impact-direct-dependent': 'change-impact',
  'change-impact-unresolved-edge': 'change-impact',
  'focused-pipeline-recommend-only': 'focused-pipeline',
  'focused-pipeline-explicit-run': 'focused-pipeline',
});
const FROZEN_INPUTS = Object.freeze({
  suiteSHA256: '201958f03dc3b85ea6bfe9cca3b5edfec88124da8a790539639465fab8f46cf7',
  fixtureCatalogSHA256: 'def2454c3e56917812c0cb07c67523a4b90d15c1f24f4834c5ff6fa189b03982',
  taskGoalsSHA256: '810103d0f1358685db035f6f1f711895f411c21e15ba0f8b9de1c3a6761d8e5d',
  executionContractsSHA256: 'aa02c3d604dbad28c182ff9ae1df836b7781d671b199a48f3df3e7a4fe3f6163',
});
export const PHASE3_PROVIDER_USAGE_FORMATS = Object.freeze([
  'codex-exec-jsonl.v1:turn.completed.usage',
  'openai-responses-jsonl.v1:response.completed.response.usage',
]);

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value, expected, label) {
  if (!plainObject(value)) throw new Error(`${label} must be an object`);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(`${label} has invalid fields`);
  }
}

function requireDigest(value, label) {
  if (typeof value !== 'string' || !SHA256.test(value)) throw new Error(`${label} must be SHA-256`);
  return value;
}

function requireString(value, label) {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0')) throw new Error(`${label} must be a nonempty string`);
  return value;
}

function frozenDigest(bytes) {
  return sha256Hex(bytes);
}

function armOrder(seed, taskId, repetition) {
  return [...ARMS].sort((left, right) => {
    const a = sha256Hex(`${seed}\0${taskId}\0${repetition}\0${left}`);
    const b = sha256Hex(`${seed}\0${taskId}\0${repetition}\0${right}`);
    return a.localeCompare(b) || left.localeCompare(right);
  });
}

function validateRunConfiguration(configuration) {
  exactKeys(configuration, [
    'schema', 'provider', 'modelSnapshot', 'reasoningEffort', 'sandbox',
    'commonHostCatalogDigest', 'armBindings',
  ], 'run configuration');
  if (configuration.schema !== 'aishell.phase3-run-configuration.v1') throw new Error('invalid run configuration schema');
  requireString(configuration.provider, 'provider');
  requireString(configuration.modelSnapshot, 'model snapshot');
  requireString(configuration.reasoningEffort, 'reasoning effort');
  requireDigest(configuration.commonHostCatalogDigest, 'common host catalog digest');
  if (!plainObject(configuration.sandbox) || Object.keys(configuration.sandbox).length === 0) {
    throw new Error('sandbox must be a nonempty exact configuration');
  }
  exactKeys(configuration.armBindings, ARMS, 'arm bindings');
  for (const arm of ARMS) {
    const binding = configuration.armBindings[arm];
    exactKeys(binding, ['binding', 'aishellBinaryDigest', 'aishellToolCatalogDigest'], `${arm} binding`);
    requireString(binding.binding, `${arm} binding description`);
    if (arm === 'native') {
      if (binding.aishellBinaryDigest !== null || binding.aishellToolCatalogDigest !== null) {
        throw new Error('native arm must not bind an AIShell binary or catalog');
      }
    } else {
      requireDigest(binding.aishellBinaryDigest, `${arm} binary digest`);
      requireDigest(binding.aishellToolCatalogDigest, `${arm} AIShell catalog digest`);
    }
  }
}

async function loadFrozenInputs() {
  const files = {
    suite: new URL('representative-suite.v1.json', here),
    catalog: new URL('capability-fixtures.v1.json', here),
    goals: new URL('representative-task-goals.v1.json', here),
    execution: new URL('representative-execution-contracts.v1.json', here),
  };
  const entries = await Promise.all(Object.entries(files).map(async ([key, url]) => {
    const bytes = await readFile(url);
    return [key, { bytes, value: JSON.parse(bytes.toString('utf8')), sha256: frozenDigest(bytes) }];
  }));
  return Object.fromEntries(entries);
}

export function oracleFreeFixtureMaterial(fixture, scenario) {
  if (!plainObject(fixture) || !plainObject(scenario) || typeof fixture.id !== 'string'
    || !plainObject(fixture.seedFiles) || !Array.isArray(scenario.mutation)) {
    throw new Error('invalid fixture material');
  }
  return { fixtureID: fixture.id, seedFiles: fixture.seedFiles, mutation: scenario.mutation };
}

function fixtureMaterialDigest(task, catalog) {
  const fixture = catalog.fixtures.find(({ id }) => id === task.fixture);
  const scenario = fixture?.scenarios?.[task.scenario];
  if (!fixture || !scenario) throw new Error(`unknown frozen fixture: ${task.id}`);
  // Oracle values are deliberately excluded: they belong only to the external evaluator.
  return sha256Hex(canonicalJSONBytes(oracleFreeFixtureMaterial(fixture, scenario)));
}

export function validatePhase3AttemptManifest(manifest) {
  exactKeys(manifest, ['schema', 'phase', 'frozenInputs', 'isolation', 'armBindings', 'tasks', 'attempts'], 'attempt manifest');
  if (manifest.schema !== 'aishell.phase3-representative-attempt-manifest.v1' || manifest.phase !== 'phase-3') {
    throw new Error('invalid phase 3 attempt manifest schema');
  }
  exactKeys(manifest.frozenInputs, [
    'suiteSHA256', 'fixtureCatalogSHA256', 'taskGoalsSHA256', 'executionContractsSHA256',
  ], 'frozen input bindings');
  for (const [key, value] of Object.entries(manifest.frozenInputs)) requireDigest(value, `frozen input ${key}`);
  if (JSON.stringify(manifest.frozenInputs) !== JSON.stringify(FROZEN_INPUTS)) throw new Error('frozen input digest changed');
  exactKeys(manifest.isolation, [
    'provider', 'modelSnapshot', 'reasoningEffort', 'sandboxSHA256', 'commonHostCatalogDigest',
    'pairedRandomizationSeed', 'freshWorkspacePerAttempt', 'replaceInvalidAttempts',
  ], 'isolation binding');
  requireString(manifest.isolation.provider, 'provider');
  requireString(manifest.isolation.modelSnapshot, 'model snapshot');
  requireString(manifest.isolation.reasoningEffort, 'reasoning effort');
  requireDigest(manifest.isolation.sandboxSHA256, 'sandbox digest');
  requireDigest(manifest.isolation.commonHostCatalogDigest, 'common host catalog digest');
  if (manifest.isolation.pairedRandomizationSeed !== 'aishell-capability-expansion-v1'
    || manifest.isolation.freshWorkspacePerAttempt !== true || manifest.isolation.replaceInvalidAttempts !== false) {
    throw new Error('phase 3 isolation contract changed');
  }
  exactKeys(manifest.armBindings, ARMS, 'manifest arm bindings');
  for (const arm of ARMS) {
    const binding = manifest.armBindings[arm];
    exactKeys(binding, ['binding', 'aishellBinaryDigest', 'aishellToolCatalogDigest'], `manifest ${arm} binding`);
    requireString(binding.binding, `manifest ${arm} binding description`);
    if (arm === 'native') {
      if (binding.aishellBinaryDigest !== null || binding.aishellToolCatalogDigest !== null) {
        throw new Error('manifest native arm must not bind AIShell');
      }
    } else {
      requireDigest(binding.aishellBinaryDigest, `manifest ${arm} binary`);
      requireDigest(binding.aishellToolCatalogDigest, `manifest ${arm} catalog`);
    }
  }
  if (JSON.stringify(manifest.tasks) !== JSON.stringify(PHASE3_TASKS)) throw new Error('phase 3 task set or order changed');
  if (!Array.isArray(manifest.attempts) || manifest.attempts.length !== 54) throw new Error('manifest must contain exactly 54 attempts');
  let index = 0;
  for (const taskID of PHASE3_TASKS) {
    for (let repetition = 1; repetition <= 3; repetition += 1) {
      const order = armOrder(manifest.isolation.pairedRandomizationSeed, taskID, repetition);
      let promptSHA256 = null;
      let fixtureSHA256 = null;
      for (const arm of order) {
        const attempt = manifest.attempts[index];
        exactKeys(attempt, [
          'attemptID', 'sequence', 'taskID', 'fixtureID', 'arm', 'repetition', 'promptSHA256',
          'materializedFixtureSHA256', 'armBindingSHA256',
        ], `manifest attempt ${index + 1}`);
        const sequence = index + 1;
        if (attempt.sequence !== sequence || attempt.taskID !== taskID || attempt.arm !== arm || attempt.repetition !== repetition
          || attempt.attemptID !== `phase3-${String(sequence).padStart(2, '0')}-${taskID}-${arm}-r${repetition}`) {
          throw new Error(`manifest attempt ${sequence} violates frozen order`);
        }
        if (attempt.fixtureID !== PHASE3_FIXTURES[taskID]) throw new Error(`manifest attempt ${sequence} fixture changed`);
        requireDigest(attempt.promptSHA256, `manifest attempt ${sequence} prompt`);
        requireDigest(attempt.materializedFixtureSHA256, `manifest attempt ${sequence} fixture bytes`);
        requireDigest(attempt.armBindingSHA256, `manifest attempt ${sequence} arm binding`);
        if (attempt.armBindingSHA256 !== sha256Hex(canonicalJSONBytes(manifest.armBindings[arm]))) {
          throw new Error(`manifest attempt ${sequence} arm binding mismatch`);
        }
        promptSHA256 ??= attempt.promptSHA256;
        fixtureSHA256 ??= attempt.materializedFixtureSHA256;
        if (attempt.promptSHA256 !== promptSHA256 || attempt.materializedFixtureSHA256 !== fixtureSHA256) {
          throw new Error(`task ${taskID} repetition ${repetition} differs across arms`);
        }
        index += 1;
      }
    }
  }
  return manifest;
}

export async function buildPhase3AttemptManifest(configuration) {
  validateRunConfiguration(configuration);
  const frozen = await loadFrozenInputs();
  if (frozen.suite.value.repetitionsPerTask !== 3
    || frozen.suite.value.isolation?.pairedRandomizationSeed !== 'aishell-capability-expansion-v1') {
    throw new Error('frozen repetition/randomization contract changed');
  }
  const tasks = PHASE3_TASKS.map((taskId) => {
    const task = frozen.suite.value.tasks.find(({ id }) => id === taskId);
    if (!task) throw new Error(`phase 3 task missing from frozen suite: ${taskId}`);
    return task;
  });
  const attempts = [];
  let sequence = 1;
  for (const task of tasks) {
    const prompt = await renderRepresentativePrompt(task.id);
    const promptBytes = Buffer.from(prompt, 'utf8');
    const fixtureDigest = fixtureMaterialDigest(task, frozen.catalog.value);
    for (let repetition = 1; repetition <= 3; repetition += 1) {
      for (const arm of armOrder(frozen.suite.value.isolation.pairedRandomizationSeed, task.id, repetition)) {
        attempts.push({
          attemptID: `phase3-${String(sequence).padStart(2, '0')}-${task.id}-${arm}-r${repetition}`,
          sequence,
          taskID: task.id,
          fixtureID: task.fixture,
          arm,
          repetition,
          promptSHA256: sha256Hex(promptBytes),
          materializedFixtureSHA256: fixtureDigest,
          armBindingSHA256: sha256Hex(canonicalJSONBytes(configuration.armBindings[arm])),
        });
        sequence += 1;
      }
    }
  }
  if (attempts.length !== 54) throw new Error('phase 3 manifest must contain exactly 54 attempts');
  return validatePhase3AttemptManifest({
    schema: 'aishell.phase3-representative-attempt-manifest.v1',
    phase: 'phase-3',
    frozenInputs: {
      suiteSHA256: frozen.suite.sha256,
      fixtureCatalogSHA256: frozen.catalog.sha256,
      taskGoalsSHA256: frozen.goals.sha256,
      executionContractsSHA256: frozen.execution.sha256,
    },
    isolation: {
      provider: configuration.provider,
      modelSnapshot: configuration.modelSnapshot,
      reasoningEffort: configuration.reasoningEffort,
      sandboxSHA256: sha256Hex(canonicalJSONBytes(configuration.sandbox)),
      commonHostCatalogDigest: configuration.commonHostCatalogDigest,
      pairedRandomizationSeed: frozen.suite.value.isolation.pairedRandomizationSeed,
      freshWorkspacePerAttempt: true,
      replaceInvalidAttempts: false,
    },
    armBindings: configuration.armBindings,
    tasks: [...PHASE3_TASKS],
    attempts,
  });
}

/** Materialize frozen v1 calls and adapt candidate calls to their production v2 requests. */
export async function prepareCandidateRequests({
  taskId, workspaceRoot, preAttemptManifest, baselineManifest, setupEvidence, trustedProductionSetup,
}) {
  if (!PHASE3_TASKS.includes(taskId)) throw new Error(`not a phase 3 task: ${taskId}`);
  const frozen = await loadFrozenInputs();
  const contract = materializeRequestContract({
    taskId,
    workspaceRoot,
    preAttemptManifest,
    baselineManifest,
    setupEvidence,
    suite: frozen.suite.value,
    catalog: frozen.catalog.value,
    execution: frozen.execution.value,
  });
  const calls = contract.requiredCalls.map((call) => {
    const setup = trustedProductionSetup?.[call.tool];
    const productionRequest = adaptFrozenCapabilityRequest({
      tool: call.tool,
      request: call.requestSubset,
      trustedSetupEvidence: setup,
    });
    return {
      tool: call.tool,
      action: call.action,
      frozenRequest: call.requestSubset,
      frozenRequestBytes: canonicalJSONBytes(call.requestSubset),
      productionRequest,
      productionRequestBytes: canonicalJSONBytes(productionRequest),
    };
  });
  return { contract, calls };
}

/** Project one production result and retain byte-exact adapter trace evidence. */
function parseExactResultBytes(bytes, expected, label) {
  if (!(typeof bytes === 'string' || Buffer.isBuffer(bytes) || ArrayBuffer.isView(bytes))) {
    throw new Error(`${label} exact bytes are required`);
  }
  const exact = Buffer.from(bytes);
  let parsed;
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(exact));
  } catch {
    throw new Error(`${label} must be exact UTF-8 JSON bytes`);
  }
  if (!canonicalJSONBytes(parsed).equals(canonicalJSONBytes(expected))) throw new Error(`${label} bytes/object mismatch`);
  return exact;
}

export function recordCandidateProjection({
  preparedCall, trustedSetupEvidence, productionResult, productionResultBytes, rawV2Pages, completeArtifactBytes,
}) {
  const exactProductionResult = parseExactResultBytes(productionResultBytes, productionResult, 'production result');
  if (preparedCall.tool === 'change_impact') {
    if (!Array.isArray(rawV2Pages) || rawV2Pages.length === 0) throw new Error('change_impact raw v2 pages are required');
    const firstPageBytes = parseExactResultBytes(rawV2Pages[0].resultBytes, rawV2Pages[0].result, 'first production page');
    if (!firstPageBytes.equals(exactProductionResult)) throw new Error('production result bytes differ from first raw page');
  }
  const projected = projectProductionV2Result({
    tool: preparedCall.tool,
    frozenRequest: preparedCall.frozenRequest,
    productionResult,
    rawV2Pages,
    completeArtifactBytes,
  });
  const projectedBytes = canonicalJSONBytes(projected);
  const trace = buildBenchmarkTrace({
    v1RequestBytes: preparedCall.frozenRequestBytes,
    trustedSetupEvidence,
    v2RequestBytes: preparedCall.productionRequestBytes,
    rawV2Pages: rawV2Pages ?? [{ result: productionResult, resultBytes: exactProductionResult }],
    completeArtifactBytes: completeArtifactBytes ?? Buffer.alloc(0),
    projectedV1Bytes: projectedBytes,
  });
  return { projected, projectedBytes, productionResultBytes: exactProductionResult, trace };
}

function decodeExactBytes(binding, label) {
  exactKeys(binding, ['encoding', 'base64', 'byteLength', 'sha256'], label);
  if (binding.encoding !== 'base64' || typeof binding.base64 !== 'string'
    || !Number.isInteger(binding.byteLength) || binding.byteLength < 0) throw new Error(`${label} is invalid`);
  requireDigest(binding.sha256, `${label} digest`);
  const bytes = Buffer.from(binding.base64, 'base64');
  if (bytes.toString('base64') !== binding.base64 || bytes.length !== binding.byteLength || sha256Hex(bytes) !== binding.sha256) {
    throw new Error(`${label} bytes/digest mismatch`);
  }
  return bytes;
}

export function exactByteBinding(bytes) {
  const value = Buffer.from(bytes);
  return { encoding: 'base64', base64: value.toString('base64'), byteLength: value.length, sha256: sha256Hex(value) };
}

function jsonSafeTrace(value) {
  if (Buffer.isBuffer(value) || ArrayBuffer.isView(value)) return exactByteBinding(value);
  if (Array.isArray(value)) return value.map(jsonSafeTrace);
  if (plainObject(value)) return Object.fromEntries(Object.entries(value).map(([key, nested]) => [key, jsonSafeTrace(nested)]));
  return value;
}

export function candidateAdapterTraceBytes({
  attemptID, taskID, preparedCall, benchmarkSetupEvidence, trustedSetupEvidence, productionResultBytes,
  trace, completeArtifactBytes = Buffer.alloc(0), projectedResultBytes,
}) {
  requireString(attemptID, 'adapter attempt ID');
  if (!PHASE3_TASKS.includes(taskID)) throw new Error('adapter task ID is invalid');
  const exactProductionResult = Buffer.from(productionResultBytes);
  return canonicalJSONBytes({
    schema: 'aishell.phase3-candidate-adapter-trace.v1',
    attemptBinding: {
      attemptID,
      taskID,
      tool: preparedCall.tool,
      frozenRequest: exactByteBinding(preparedCall.frozenRequestBytes),
      benchmarkSetup: exactByteBinding(canonicalJSONBytes(benchmarkSetupEvidence)),
      trustedSetup: exactByteBinding(canonicalJSONBytes(trustedSetupEvidence)),
      productionRequest: exactByteBinding(preparedCall.productionRequestBytes),
      productionResult: exactByteBinding(exactProductionResult),
    },
    productionTrace: jsonSafeTrace(trace),
    completeArtifact: exactByteBinding(completeArtifactBytes),
    projectedResult: exactByteBinding(projectedResultBytes),
  });
}

function validateCandidateAdapterTrace(bytes, label, expectedAttempt) {
  let envelope;
  try {
    envelope = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw new Error(`${label} must be UTF-8 JSON`);
  }
  exactKeys(envelope, ['schema', 'attemptBinding', 'productionTrace', 'completeArtifact', 'projectedResult'], label);
  if (envelope.schema !== 'aishell.phase3-candidate-adapter-trace.v1') throw new Error(`${label} schema is invalid`);
  const binding = envelope.attemptBinding;
  exactKeys(binding, [
    'attemptID', 'taskID', 'tool', 'frozenRequest', 'benchmarkSetup', 'trustedSetup', 'productionRequest', 'productionResult',
  ], `${label} attempt binding`);
  const expectedTool = expectedAttempt.taskID.startsWith('freshness-cache-') ? 'run_check' : 'change_impact';
  if (binding.attemptID !== expectedAttempt.attemptID || binding.taskID !== expectedAttempt.taskID || binding.tool !== expectedTool) {
    throw new Error(`${label} belongs to a different attempt`);
  }
  const frozenRequest = decodeExactBytes(binding.frozenRequest, `${label} frozen request`);
  const benchmarkSetupBytes = decodeExactBytes(binding.benchmarkSetup, `${label} benchmark setup`);
  const trustedSetupBytes = decodeExactBytes(binding.trustedSetup, `${label} trusted setup`);
  const productionRequest = decodeExactBytes(binding.productionRequest, `${label} production request`);
  const productionResult = decodeExactBytes(binding.productionResult, `${label} production result`);
  let frozenRequestValue;
  let benchmarkSetup;
  let trustedSetup;
  let productionResultValue;
  try {
    frozenRequestValue = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(frozenRequest));
    benchmarkSetup = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(benchmarkSetupBytes));
    trustedSetup = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(trustedSetupBytes));
    productionResultValue = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(productionResult));
  } catch {
    throw new Error(`${label} request/setup binding is not UTF-8 JSON`);
  }
  const expectedFrozenRequest = expectedAttempt.taskID.startsWith('freshness-cache-')
    ? { action: 'execute', executable: 'node', arguments: ['check.mjs'], freshness_inputs: ['check.mjs', 'src/value.mjs'] }
    : {
      action: expectedAttempt.taskID.startsWith('focused-pipeline-') ? 'recommend' : 'analyze',
      changed_paths: expectedAttempt.taskID === 'change-impact-unresolved-edge' ? ['src/dynamic.mjs'] : ['src/a.mjs'],
      providers: ['static-import'],
    };
  if (!canonicalJSONBytes(frozenRequestValue).equals(canonicalJSONBytes(expectedFrozenRequest))
    || benchmarkSetup?.schema !== 'aishell.benchmark-setup-evidence.v1'
    || benchmarkSetup.taskId !== expectedAttempt.taskID) {
    throw new Error(`${label} is not bound to the frozen task request/setup`);
  }
  const artifact = decodeExactBytes(envelope.completeArtifact, `${label} artifact`);
  const projected = decodeExactBytes(envelope.projectedResult, `${label} projected result`);
  const trace = envelope.productionTrace;
  if (!plainObject(trace) || trace.schema !== 'aishell.production-v2-benchmark-trace.v1' || !Array.isArray(trace.stages)) {
    throw new Error(`${label} production trace is invalid`);
  }
  const kinds = trace.stages.map((stage) => stage?.kind);
  if (JSON.stringify(kinds) !== JSON.stringify([
    'v1_request', 'trusted_setup', 'v2_request', 'raw_v2_pages', 'projected_v1_result',
  ])) throw new Error(`${label} stage order is invalid`);
  for (const index of [0, 2, 4]) {
    const stage = trace.stages[index];
    const stageBytes = decodeExactBytes(stage.bytes, `${label} stage ${index} bytes`);
    if (stage.sha256 !== sha256Hex(stageBytes)) throw new Error(`${label} stage ${index} digest mismatch`);
  }
  if (!decodeExactBytes(trace.stages[0].bytes, `${label} v1 request`).equals(frozenRequest)
    || !decodeExactBytes(trace.stages[2].bytes, `${label} v2 request`).equals(productionRequest)
    || trace.stages[1].sha256 !== binding.trustedSetup.sha256) {
    throw new Error(`${label} prepared request/setup binding mismatch`);
  }
  requireDigest(trace.stages[1].sha256, `${label} trusted setup`);
  const raw = trace.stages[3];
  if (!Array.isArray(raw.pages) || raw.pages.length === 0 || !Array.isArray(raw.pageTokenChain)
    || raw.pages.length !== raw.pageTokenChain.length || raw.completeArtifactSHA256 !== sha256Hex(artifact)) {
    throw new Error(`${label} raw page/artifact binding is invalid`);
  }
  for (const [index, page] of raw.pages.entries()) {
    const resultBytes = decodeExactBytes(page.resultBytes, `${label} raw page ${index}`);
    if (page.sha256 !== sha256Hex(resultBytes)) throw new Error(`${label} raw page ${index} digest mismatch`);
  }
  if (!decodeExactBytes(raw.pages[0].resultBytes, `${label} first production page`).equals(productionResult)) {
    throw new Error(`${label} production result differs from raw trace`);
  }
  const projectedStageBytes = decodeExactBytes(trace.stages[4].bytes, `${label} projected stage`);
  if (!projectedStageBytes.equals(projected)) throw new Error(`${label} projected bytes differ from trace`);
  const expectedProductionRequest = adaptFrozenCapabilityRequest({
    tool: binding.tool,
    request: frozenRequestValue,
    trustedSetupEvidence: trustedSetup,
  });
  if (!canonicalJSONBytes(expectedProductionRequest).equals(productionRequest)) {
    throw new Error(`${label} production request differs from adapter output`);
  }
  const expectedProjection = binding.tool === 'run_check'
    ? projectProductionV2Result({
      tool: binding.tool,
      frozenRequest: frozenRequestValue,
      productionResult: productionResultValue,
    })
    : projectProductionV2Result({
      tool: binding.tool,
      frozenRequest: frozenRequestValue,
      rawV2Pages: raw.pages.map((page, index) => ({
        requestToken: page.requestToken ?? (index === 0 ? null : page.requestToken),
        result: JSON.parse(new TextDecoder('utf-8', { fatal: true })
          .decode(decodeExactBytes(page.resultBytes, `${label} raw page ${index} projection`))),
      })),
      completeArtifactBytes: artifact,
    });
  if (!canonicalJSONBytes(expectedProjection).equals(projected)) {
    throw new Error(`${label} projected result differs from production adapter`);
  }
}

function validateUsage(usage, label) {
  if (usage === null || usage === undefined) throw new Error(`${label} is missing`);
  exactKeys(usage, [
    'source', 'inputTokens', 'cachedInputTokens', 'outputTokens', 'reasoningOutputTokens', 'totalModelTokens',
  ], label);
  if (usage.source !== 'provider') throw new Error(`${label} is not provider-reported`);
  for (const key of ['inputTokens', 'cachedInputTokens', 'outputTokens', 'reasoningOutputTokens', 'totalModelTokens']) {
    if (!Number.isSafeInteger(usage[key]) || usage[key] < 0) throw new Error(`${label}.${key} is invalid`);
  }
  if (usage.cachedInputTokens > usage.inputTokens || usage.reasoningOutputTokens > usage.outputTokens
    || usage.totalModelTokens !== usage.inputTokens + usage.outputTokens) {
    throw new Error(`${label} token accounting is inconsistent`);
  }
}

export function normalizeProviderUsage(providerUsage) {
  if (!plainObject(providerUsage)) throw new Error('provider usage is missing');
  const integer = (...keys) => {
    const value = keys.map((key) => providerUsage[key]).find((item) => item !== undefined);
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
  };
  const usage = {
    source: 'provider',
    inputTokens: integer('input_tokens', 'inputTokens'),
    cachedInputTokens: integer('cached_input_tokens', 'cachedInputTokens'),
    outputTokens: integer('output_tokens', 'outputTokens'),
    reasoningOutputTokens: integer('reasoning_output_tokens', 'reasoningOutputTokens'),
    totalModelTokens: integer('total_model_tokens', 'totalTokens', 'total_tokens'),
  };
  if (usage.totalModelTokens === null && usage.inputTokens !== null && usage.outputTokens !== null) {
    usage.totalModelTokens = usage.inputTokens + usage.outputTokens;
  }
  validateUsage(usage, 'provider usage');
  return usage;
}

export function extractProviderUsageFromTrace(providerTraceBytes) {
  const bytes = Buffer.from(providerTraceBytes);
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new Error('provider trace must be UTF-8 JSONL');
  }
  const events = text.split('\n').filter((line) => line.length > 0).map((line, index) => {
    try {
      const event = JSON.parse(line);
      if (!plainObject(event)) throw new Error();
      return event;
    } catch {
      throw new Error(`provider trace line ${index + 1} is not a JSON object`);
    }
  });
  const carriers = [];
  for (const event of events) {
    if (event.type === 'turn.completed' && plainObject(event.usage)) {
      carriers.push({ format: 'codex-exec-jsonl.v1', usage: event.usage });
    } else if (event.type === 'response.completed' && plainObject(event.response?.usage)) {
      carriers.push({ format: 'openai-responses-jsonl.v1', usage: event.response.usage });
    }
  }
  if (carriers.length !== 1) throw new Error('provider trace must contain exactly one supported completed usage event');
  return { format: carriers[0].format, usage: normalizeProviderUsage(carriers[0].usage) };
}

export function assertNoOracleValueSentinels(surfaces, sentinels) {
  if (!plainObject(surfaces) || !Array.isArray(sentinels) || sentinels.length === 0) {
    throw new Error('oracle sentinel audit requires surfaces and sentinels');
  }
  const auditBytes = (value, output = []) => {
    if (Buffer.isBuffer(value) || ArrayBuffer.isView(value)) {
      const bytes = Buffer.from(value);
      output.push(bytes);
      const text = bytes.toString('utf8').trim();
      if (text.startsWith('{') || text.startsWith('[')) {
        try { auditBytes(JSON.parse(text), output); } catch { /* Exact non-JSON bytes remain auditable as raw bytes. */ }
      }
    } else if (typeof value === 'string') {
      output.push(Buffer.from(value, 'utf8'));
    } else if (Array.isArray(value)) {
      value.forEach((nested) => auditBytes(nested, output));
    } else if (plainObject(value)) {
      if (value.encoding === 'base64' && typeof value.base64 === 'string') {
        auditBytes(Buffer.from(value.base64, 'base64'), output);
      }
      Object.values(value).forEach((nested) => auditBytes(nested, output));
    }
    return output;
  };
  const encoded = Object.entries(surfaces).map(([name, value]) => [name, auditBytes(value)]);
  for (const sentinel of sentinels) {
    requireString(sentinel, 'oracle value sentinel');
    const needle = Buffer.from(sentinel, 'utf8');
    for (const [name, byteValues] of encoded) {
      if (byteValues.some((bytes) => bytes.includes(needle))) throw new Error(`oracle value sentinel leaked into ${name}`);
    }
  }
  return true;
}

function collectResultFailures(result, manifest) {
  const reasons = [];
  const invalidate = (message) => reasons.push(message);
  try {
    validatePhase3AttemptManifest(manifest);
    exactKeys(result, ['schema', 'manifestSHA256', 'status', 'invalidReasons', 'attempts'], 'phase 3 result');
    if (result.schema !== 'aishell.phase3-representative-result.v1') throw new Error('invalid phase 3 result schema');
    const manifestDigest = sha256Hex(canonicalJSONBytes(manifest));
    if (result.manifestSHA256 !== manifestDigest) throw new Error('result does not bind the exact attempt manifest');
    if (!Array.isArray(result.attempts) || result.attempts.length !== 54) throw new Error('result must contain exactly 54 attempts');
    for (let index = 0; index < manifest.attempts.length; index += 1) {
      const expected = manifest.attempts[index];
      const attempt = result.attempts[index];
      try {
        exactKeys(attempt, [
          'attemptID', 'sequence', 'taskID', 'arm', 'repetition', 'usage', 'providerTrace', 'agentResult',
          'providerUsageFormat', 'adapterTrace', 'agentExitCode', 'timedOut', 'wallMilliseconds',
        ], `attempt ${index + 1}`);
        for (const key of ['attemptID', 'sequence', 'taskID', 'arm', 'repetition']) {
          if (attempt[key] !== expected[key]) throw new Error(`attempt ${index + 1} ${key} differs from manifest`);
        }
        validateUsage(attempt.usage, `attempt ${index + 1} usage`);
        const providerTrace = decodeExactBytes(attempt.providerTrace, `attempt ${index + 1} provider trace`);
        const extracted = extractProviderUsageFromTrace(providerTrace);
        if (attempt.providerUsageFormat !== extracted.format) throw new Error(`attempt ${index + 1} provider usage format mismatch`);
        const extractedUsage = extracted.usage;
        if (!canonicalJSONBytes(extractedUsage).equals(canonicalJSONBytes(attempt.usage))) {
          throw new Error(`attempt ${index + 1} usage differs from provider trace`);
        }
        const agentResult = decodeExactBytes(attempt.agentResult, `attempt ${index + 1} agent result`);
        if (providerTrace.length === 0 || agentResult.length === 0) throw new Error(`attempt ${index + 1} exact evidence is empty`);
        if (attempt.arm === 'candidate') {
          if (attempt.adapterTrace === null) throw new Error(`attempt ${index + 1} candidate adapter trace is missing`);
          const adapterTraceBytes = decodeExactBytes(attempt.adapterTrace, `attempt ${index + 1} adapter trace`);
          if (adapterTraceBytes.length === 0) {
            throw new Error(`attempt ${index + 1} candidate adapter trace is empty`);
          }
          validateCandidateAdapterTrace(adapterTraceBytes, `attempt ${index + 1} adapter trace`, expected);
        } else if (attempt.adapterTrace !== null) {
          throw new Error(`attempt ${index + 1} non-candidate adapter trace must be null`);
        }
        if (!Number.isInteger(attempt.agentExitCode) || typeof attempt.timedOut !== 'boolean'
          || !Number.isSafeInteger(attempt.wallMilliseconds) || attempt.wallMilliseconds < 0) {
          throw new Error(`attempt ${index + 1} execution outcome is invalid`);
        }
      } catch (error) {
        invalidate(error.message);
      }
    }
  } catch (error) {
    invalidate(error.message);
  }
  return [...new Set(reasons)].sort();
}

export function assemblePhase3Result(manifest, attemptRecords) {
  validatePhase3AttemptManifest(manifest);
  const result = {
    schema: 'aishell.phase3-representative-result.v1',
    manifestSHA256: sha256Hex(canonicalJSONBytes(manifest)),
    status: 'valid',
    invalidReasons: [],
    attempts: attemptRecords,
  };
  result.invalidReasons = collectResultFailures(result, manifest);
  result.status = result.invalidReasons.length === 0 ? 'valid' : 'invalid';
  return result;
}

/** Execute the frozen order through an injected provider executor; this module never reads oracle values. */
export async function runPhase3Attempts({ manifest, executeAttempt }) {
  if (typeof executeAttempt !== 'function') throw new Error('executeAttempt callback is required');
  validatePhase3AttemptManifest(manifest);
  const records = [];
  for (const attempt of manifest.attempts) {
    const prompt = await renderRepresentativePrompt(attempt.taskID);
    if (sha256Hex(Buffer.from(prompt, 'utf8')) !== attempt.promptSHA256) throw new Error(`prompt binding changed: ${attempt.attemptID}`);
    const record = await executeAttempt(Object.freeze({
      attempt: structuredClone(attempt),
      isolation: structuredClone(manifest.isolation),
      armBinding: structuredClone(manifest.armBindings[attempt.arm]),
      prompt,
    }));
    records.push(record);
  }
  return assemblePhase3Result(manifest, records);
}

export function validatePhase3Result(result, manifest) {
  const uniqueReasons = collectResultFailures(result, manifest);
  const expectedStatus = uniqueReasons.length === 0 ? 'valid' : 'invalid';
  if (result?.status !== expectedStatus) uniqueReasons.push(`result status must be ${expectedStatus}`);
  const declared = Array.isArray(result?.invalidReasons) ? [...new Set(result.invalidReasons)].sort() : null;
  if (declared === null || JSON.stringify(declared) !== JSON.stringify(uniqueReasons.sort())) {
    uniqueReasons.push('invalidReasons do not exactly match validation failures');
  }
  return { valid: uniqueReasons.length === 0, reasons: [...new Set(uniqueReasons)].sort() };
}

async function main() {
  const [command, first, second] = process.argv.slice(2);
  if (command === 'manifest') {
    if (!first) throw new Error('usage: phase3-representative-runner.mjs manifest <configuration.json>');
    const configuration = JSON.parse(await readFile(first, 'utf8'));
    process.stdout.write(`${JSON.stringify(await buildPhase3AttemptManifest(configuration), null, 2)}\n`);
    return;
  }
  if (command === 'validate') {
    if (!first || !second) throw new Error('usage: phase3-representative-runner.mjs validate <manifest.json> <result.json>');
    const manifest = JSON.parse(await readFile(first, 'utf8'));
    const result = JSON.parse(await readFile(second, 'utf8'));
    const validation = validatePhase3Result(result, manifest);
    process.stdout.write(`${JSON.stringify(validation)}\n`);
    if (!validation.valid) process.exitCode = 1;
    return;
  }
  throw new Error('usage: phase3-representative-runner.mjs manifest|validate ...');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
