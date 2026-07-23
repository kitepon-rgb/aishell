#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

import {
  canonicalJSONBytes,
  sha256Hex,
} from './production-v2-benchmark-adapter.mjs';
import {
  extractProviderModelsFromSSETrace,
  extractProviderUsageFromSSETrace,
  oracleFreeFixtureMaterial,
} from './phase3-representative-runner.mjs';
import { renderRepresentativePrompt } from './render-representative-prompt.mjs';

const here = new URL('.', import.meta.url);
export const REPRESENTATIVE_ARMS = Object.freeze(['native', 'current-aishell-0.3.3', 'candidate']);
export const REPRESENTATIVE_REPETITIONS = Object.freeze([1, 2, 3]);
export const REPRESENTATIVE_FROZEN_INPUTS = Object.freeze({
  suiteSHA256: '3ca53c0fa9f95d6f2f277388b124fd09c1fd022a5803cdae29cefa2ebda58214',
  fixtureCatalogSHA256: 'aadb3944e3219bdf666a422488fd1ddaa3a2d5b03bceb6762b09408055c65519',
  taskGoalsSHA256: '810103d0f1358685db035f6f1f711895f411c21e15ba0f8b9de1c3a6761d8e5d',
  executionContractsSHA256: '14c17dd9e386d52f69386d99f21922eacf7846d560a5b4f40faee9a5b3bede64',
});
const SHA256 = /^[a-f0-9]{64}$/u;

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

function requireString(value, label) {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0')) {
    throw new Error(`${label} must be a nonempty string`);
  }
  return value;
}

function requireDigest(value, label) {
  if (typeof value !== 'string' || !SHA256.test(value)) throw new Error(`${label} must be SHA-256`);
  return value;
}

function validateApprovalReviewer(value, label) {
  exactKeys(value, ['mode', 'modelSnapshots'], label);
  if (value.mode !== 'auto_review' || !Array.isArray(value.modelSnapshots) || value.modelSnapshots.length === 0
    || value.modelSnapshots.some((model) => typeof model !== 'string' || model.length === 0)
    || JSON.stringify(value.modelSnapshots) !== JSON.stringify([...new Set(value.modelSnapshots)].sort())) {
    throw new Error(`${label} must freeze sorted unique auto-review model snapshots`);
  }
}

function validateArmBindings(bindings, label) {
  exactKeys(bindings, REPRESENTATIVE_ARMS, label);
  for (const arm of REPRESENTATIVE_ARMS) {
    const binding = bindings[arm];
    exactKeys(binding, ['binding', 'aishellBinaryDigest', 'aishellToolCatalogDigest'], `${label}.${arm}`);
    requireString(binding.binding, `${label}.${arm}.binding`);
    if (arm === 'native') {
      if (binding.aishellBinaryDigest !== null || binding.aishellToolCatalogDigest !== null) {
        throw new Error(`${label}.${arm} must not bind AIShell`);
      }
    } else {
      requireDigest(binding.aishellBinaryDigest, `${label}.${arm}.aishellBinaryDigest`);
      requireDigest(binding.aishellToolCatalogDigest, `${label}.${arm}.aishellToolCatalogDigest`);
    }
  }
}

async function frozenInputs() {
  const paths = {
    suite: new URL('representative-suite.v1.json', here),
    catalog: new URL('capability-fixtures.v1.json', here),
    goals: new URL('representative-task-goals.v1.json', here),
    execution: new URL('representative-execution-contracts.v1.json', here),
  };
  return Object.fromEntries(await Promise.all(Object.entries(paths).map(async ([key, url]) => {
    const bytes = await readFile(url);
    return [key, { value: JSON.parse(bytes.toString('utf8')), sha256: sha256Hex(bytes) }];
  })));
}

function armOrder(seed, taskID, repetition) {
  return [...REPRESENTATIVE_ARMS].sort((left, right) => {
    const a = sha256Hex(`${seed}\0${taskID}\0${repetition}\0${left}`);
    const b = sha256Hex(`${seed}\0${taskID}\0${repetition}\0${right}`);
    return a.localeCompare(b) || left.localeCompare(right);
  });
}

function validateRunConfiguration(configuration) {
  exactKeys(configuration, [
    'schema', 'provider', 'modelSnapshot', 'reasoningEffort', 'sandbox',
    'commonHostCatalogDigest', 'approvalReviewer', 'armBindings',
  ], 'run configuration');
  if (configuration.schema !== 'aishell.representative-run-configuration.v1') {
    throw new Error('invalid representative run configuration schema');
  }
  requireString(configuration.provider, 'provider');
  requireString(configuration.modelSnapshot, 'model snapshot');
  requireString(configuration.reasoningEffort, 'reasoning effort');
  requireDigest(configuration.commonHostCatalogDigest, 'common host catalog digest');
  if (!plainObject(configuration.sandbox) || Object.keys(configuration.sandbox).length === 0) {
    throw new Error('sandbox must be a nonempty exact configuration');
  }
  validateApprovalReviewer(configuration.approvalReviewer, 'approval reviewer');
  validateArmBindings(configuration.armBindings, 'arm bindings');
}

function fixtureDigest(task, catalog) {
  const fixture = catalog.fixtures.find(({ id }) => id === task.fixture);
  const scenario = fixture?.scenarios?.[task.scenario];
  if (!fixture || !scenario) throw new Error(`unknown frozen fixture: ${task.id}`);
  return sha256Hex(canonicalJSONBytes(oracleFreeFixtureMaterial(fixture, scenario)));
}

export async function buildRepresentativeAttemptManifest(configuration) {
  validateRunConfiguration(configuration);
  const frozen = await frozenInputs();
  const observedDigests = {
    suiteSHA256: frozen.suite.sha256,
    fixtureCatalogSHA256: frozen.catalog.sha256,
    taskGoalsSHA256: frozen.goals.sha256,
    executionContractsSHA256: frozen.execution.sha256,
  };
  if (JSON.stringify(observedDigests) !== JSON.stringify(REPRESENTATIVE_FROZEN_INPUTS)) {
    throw new Error('representative frozen input digest changed');
  }
  const suite = frozen.suite.value;
  if (suite.tasks.length !== 32 || suite.repetitionsPerTask !== 3
    || suite.isolation?.pairedRandomizationSeed !== 'aishell-capability-expansion-v1'
    || suite.isolation?.replaceInvalidAttempts !== false) {
    throw new Error('representative suite registration contract changed');
  }
  const attempts = [];
  let sequence = 1;
  for (const task of suite.tasks) {
    const prompt = await renderRepresentativePrompt(task.id, { materializeModelParameters: true });
    const promptSHA256 = sha256Hex(Buffer.from(prompt, 'utf8'));
    const materializedFixtureSHA256 = fixtureDigest(task, frozen.catalog.value);
    for (const repetition of REPRESENTATIVE_REPETITIONS) {
      for (const arm of armOrder(suite.isolation.pairedRandomizationSeed, task.id, repetition)) {
        attempts.push({
          attemptID: `representative-${String(sequence).padStart(3, '0')}-${task.id}-${arm}-r${repetition}`,
          sequence,
          taskID: task.id,
          fixtureID: task.fixture,
          arm,
          repetition,
          promptSHA256,
          materializedFixtureSHA256,
          armBindingSHA256: sha256Hex(canonicalJSONBytes(configuration.armBindings[arm])),
        });
        sequence += 1;
      }
    }
  }
  return validateRepresentativeAttemptManifest({
    schema: 'aishell.representative-attempt-manifest.v1',
    phase: 'phase-7',
    frozenInputs: observedDigests,
    isolation: {
      provider: configuration.provider,
      modelSnapshot: configuration.modelSnapshot,
      reasoningEffort: configuration.reasoningEffort,
      sandboxSHA256: sha256Hex(canonicalJSONBytes(configuration.sandbox)),
      commonHostCatalogDigest: configuration.commonHostCatalogDigest,
      approvalReviewer: configuration.approvalReviewer,
      pairedRandomizationSeed: suite.isolation.pairedRandomizationSeed,
      freshWorkspacePerAttempt: true,
      replaceInvalidAttempts: false,
    },
    armBindings: configuration.armBindings,
    tasks: suite.tasks.map(({ id }) => id),
    attempts,
  });
}

export function validateRepresentativeAttemptManifest(manifest) {
  exactKeys(manifest, ['schema', 'phase', 'frozenInputs', 'isolation', 'armBindings', 'tasks', 'attempts'], 'attempt manifest');
  if (manifest.schema !== 'aishell.representative-attempt-manifest.v1' || manifest.phase !== 'phase-7') {
    throw new Error('invalid representative attempt manifest schema');
  }
  exactKeys(manifest.frozenInputs, Object.keys(REPRESENTATIVE_FROZEN_INPUTS), 'frozen input bindings');
  if (JSON.stringify(manifest.frozenInputs) !== JSON.stringify(REPRESENTATIVE_FROZEN_INPUTS)) {
    throw new Error('representative frozen input binding changed');
  }
  exactKeys(manifest.isolation, [
    'provider', 'modelSnapshot', 'reasoningEffort', 'sandboxSHA256', 'commonHostCatalogDigest',
    'approvalReviewer', 'pairedRandomizationSeed', 'freshWorkspacePerAttempt', 'replaceInvalidAttempts',
  ], 'isolation binding');
  requireString(manifest.isolation.provider, 'provider');
  requireString(manifest.isolation.modelSnapshot, 'model snapshot');
  requireString(manifest.isolation.reasoningEffort, 'reasoning effort');
  requireDigest(manifest.isolation.sandboxSHA256, 'sandbox digest');
  requireDigest(manifest.isolation.commonHostCatalogDigest, 'host catalog digest');
  validateApprovalReviewer(manifest.isolation.approvalReviewer, 'isolation approval reviewer');
  if (manifest.isolation.pairedRandomizationSeed !== 'aishell-capability-expansion-v1'
    || manifest.isolation.freshWorkspacePerAttempt !== true || manifest.isolation.replaceInvalidAttempts !== false) {
    throw new Error('representative isolation contract changed');
  }
  validateArmBindings(manifest.armBindings, 'manifest arm bindings');
  if (!Array.isArray(manifest.tasks) || manifest.tasks.length !== 32 || new Set(manifest.tasks).size !== 32) {
    throw new Error('manifest must contain exactly 32 unique tasks');
  }
  if (!Array.isArray(manifest.attempts) || manifest.attempts.length !== 288) {
    throw new Error('manifest must contain exactly 288 attempts');
  }
  let index = 0;
  for (const taskID of manifest.tasks) {
    for (const repetition of REPRESENTATIVE_REPETITIONS) {
      const order = armOrder(manifest.isolation.pairedRandomizationSeed, taskID, repetition);
      let promptSHA256 = null;
      let fixtureSHA256 = null;
      for (const arm of order) {
        const attempt = manifest.attempts[index];
        const sequence = index + 1;
        exactKeys(attempt, [
          'attemptID', 'sequence', 'taskID', 'fixtureID', 'arm', 'repetition', 'promptSHA256',
          'materializedFixtureSHA256', 'armBindingSHA256',
        ], `manifest attempt ${sequence}`);
        if (attempt.sequence !== sequence || attempt.taskID !== taskID || attempt.arm !== arm
          || attempt.repetition !== repetition
          || attempt.attemptID !== `representative-${String(sequence).padStart(3, '0')}-${taskID}-${arm}-r${repetition}`) {
          throw new Error(`manifest attempt ${sequence} violates frozen order`);
        }
        requireString(attempt.fixtureID, `manifest attempt ${sequence} fixture`);
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

function decodeExactBytes(binding, label) {
  exactKeys(binding, ['encoding', 'base64', 'byteLength', 'sha256'], label);
  if (binding.encoding !== 'base64' || typeof binding.base64 !== 'string'
    || !Number.isSafeInteger(binding.byteLength) || binding.byteLength < 0) throw new Error(`${label} is invalid`);
  requireDigest(binding.sha256, `${label}.sha256`);
  const bytes = Buffer.from(binding.base64, 'base64');
  if (bytes.toString('base64') !== binding.base64 || bytes.length !== binding.byteLength || sha256Hex(bytes) !== binding.sha256) {
    throw new Error(`${label} bytes/digest mismatch`);
  }
  return bytes;
}

function validateUsage(usage, label) {
  exactKeys(usage, [
    'source', 'inputTokens', 'cachedInputTokens', 'outputTokens', 'reasoningOutputTokens', 'totalModelTokens',
  ], label);
  if (usage.source !== 'provider') throw new Error(`${label} must be provider-reported`);
  for (const key of ['inputTokens', 'cachedInputTokens', 'outputTokens', 'reasoningOutputTokens', 'totalModelTokens']) {
    if (!Number.isSafeInteger(usage[key]) || usage[key] < 0) throw new Error(`${label}.${key} is invalid`);
  }
  if (usage.cachedInputTokens > usage.inputTokens || usage.reasoningOutputTokens > usage.outputTokens
    || usage.totalModelTokens !== usage.inputTokens + usage.outputTokens) {
    throw new Error(`${label} token accounting is inconsistent`);
  }
}

function collectResultFailures(result, manifest) {
  const failures = [];
  const fail = (error) => failures.push(error instanceof Error ? error.message : String(error));
  try {
    validateRepresentativeAttemptManifest(manifest);
    exactKeys(result, ['schema', 'manifestSHA256', 'status', 'invalidReasons', 'attempts'], 'representative result');
    if (result.schema !== 'aishell.representative-result.v1') throw new Error('invalid representative result schema');
    if (result.manifestSHA256 !== sha256Hex(canonicalJSONBytes(manifest))) throw new Error('result manifest binding differs');
    if (!Array.isArray(result.attempts) || result.attempts.length !== 288) throw new Error('result must contain exactly 288 attempts');
    for (let index = 0; index < manifest.attempts.length; index += 1) {
      try {
        const expected = manifest.attempts[index];
        const attempt = result.attempts[index];
        exactKeys(attempt, [
          'attemptID', 'sequence', 'taskID', 'arm', 'repetition', 'usage', 'providerTrace', 'providerSSE', 'agentResult',
          'providerModels', 'providerUsageFormat', 'adapterTrace', 'agentExitCode', 'timedOut', 'wallMilliseconds',
        ], `attempt ${index + 1}`);
        for (const key of ['attemptID', 'sequence', 'taskID', 'arm', 'repetition']) {
          if (attempt[key] !== expected[key]) throw new Error(`attempt ${index + 1} ${key} differs from manifest`);
        }
        validateUsage(attempt.usage, `attempt ${index + 1} usage`);
        const providerTrace = decodeExactBytes(attempt.providerTrace, `attempt ${index + 1} provider trace`);
        const providerSSE = decodeExactBytes(attempt.providerSSE, `attempt ${index + 1} provider SSE`);
        const agentResult = decodeExactBytes(attempt.agentResult, `attempt ${index + 1} agent result`);
        if (providerTrace.length === 0 || providerSSE.length === 0 || agentResult.length === 0) {
          throw new Error(`attempt ${index + 1} exact evidence is empty`);
        }
        const extracted = extractProviderUsageFromSSETrace(providerSSE);
        const models = extractProviderModelsFromSSETrace(providerSSE);
        const expectedModels = [manifest.isolation.modelSnapshot, ...manifest.isolation.approvalReviewer.modelSnapshots].sort();
        if (JSON.stringify(attempt.providerModels) !== JSON.stringify(models)
          || JSON.stringify(models.map(({ modelSnapshot }) => modelSnapshot)) !== JSON.stringify(expectedModels)
          || attempt.providerUsageFormat !== extracted.format
          || !canonicalJSONBytes(attempt.usage).equals(canonicalJSONBytes(extracted.usage))) {
          throw new Error(`attempt ${index + 1} provider evidence differs`);
        }
        if (attempt.arm === 'candidate') {
          if (attempt.adapterTrace === null) throw new Error(`attempt ${index + 1} candidate adapter trace is missing`);
          decodeExactBytes(attempt.adapterTrace, `attempt ${index + 1} adapter trace`);
        } else if (attempt.adapterTrace !== null) {
          throw new Error(`attempt ${index + 1} non-candidate adapter trace must be null`);
        }
        if (!Number.isInteger(attempt.agentExitCode) || attempt.agentExitCode !== 0 || attempt.timedOut !== false
          || !Number.isSafeInteger(attempt.wallMilliseconds) || attempt.wallMilliseconds < 0) {
          throw new Error(`attempt ${index + 1} execution outcome is invalid`);
        }
      } catch (error) {
        fail(error);
      }
    }
  } catch (error) {
    fail(error);
  }
  return [...new Set(failures)].sort();
}

export function assembleRepresentativeResult(manifest, attemptRecords) {
  validateRepresentativeAttemptManifest(manifest);
  const result = {
    schema: 'aishell.representative-result.v1',
    manifestSHA256: sha256Hex(canonicalJSONBytes(manifest)),
    status: 'valid',
    invalidReasons: [],
    attempts: attemptRecords,
  };
  result.invalidReasons = collectResultFailures(result, manifest);
  result.status = result.invalidReasons.length === 0 ? 'valid' : 'invalid';
  return result;
}

export function validateRepresentativeResult(result, manifest) {
  const reasons = collectResultFailures(result, manifest);
  const expectedStatus = reasons.length === 0 ? 'valid' : 'invalid';
  if (result?.status !== expectedStatus) reasons.push(`result status must be ${expectedStatus}`);
  const declared = Array.isArray(result?.invalidReasons) ? [...new Set(result.invalidReasons)].sort() : null;
  if (declared === null || JSON.stringify(declared) !== JSON.stringify([...new Set(reasons)].sort())) {
    reasons.push('invalidReasons do not exactly match validation failures');
  }
  return { valid: reasons.length === 0, reasons: [...new Set(reasons)].sort() };
}

export async function runRepresentativeAttempts({ manifest, executeAttempt, priorRecords = [], onRecord = async () => {} }) {
  validateRepresentativeAttemptManifest(manifest);
  if (typeof executeAttempt !== 'function' || typeof onRecord !== 'function') throw new Error('attempt callbacks are required');
  if (!Array.isArray(priorRecords) || priorRecords.length > manifest.attempts.length) throw new Error('prior records are invalid');
  for (let index = 0; index < priorRecords.length; index += 1) {
    if (priorRecords[index]?.attemptID !== manifest.attempts[index].attemptID) throw new Error('prior records are not a frozen prefix');
  }
  const records = [...priorRecords];
  for (const attempt of manifest.attempts.slice(records.length)) {
    const prompt = await renderRepresentativePrompt(attempt.taskID, { materializeModelParameters: true });
    if (sha256Hex(Buffer.from(prompt, 'utf8')) !== attempt.promptSHA256) throw new Error(`prompt binding changed: ${attempt.attemptID}`);
    const record = await executeAttempt(Object.freeze({
      attempt: structuredClone(attempt), isolation: structuredClone(manifest.isolation),
      armBinding: structuredClone(manifest.armBindings[attempt.arm]), prompt,
    }));
    records.push(record);
    await onRecord(structuredClone(record), records.length);
  }
  return assembleRepresentativeResult(manifest, records);
}

async function main() {
  const [command, first, second] = process.argv.slice(2);
  if (command === 'manifest') {
    if (!first) throw new Error('usage: representative-production-runner.mjs manifest <configuration.json>');
    process.stdout.write(`${JSON.stringify(await buildRepresentativeAttemptManifest(JSON.parse(await readFile(first, 'utf8'))), null, 2)}\n`);
    return;
  }
  if (command === 'validate') {
    if (!first || !second) throw new Error('usage: representative-production-runner.mjs validate <manifest.json> <result.json>');
    const validation = validateRepresentativeResult(
      JSON.parse(await readFile(second, 'utf8')),
      JSON.parse(await readFile(first, 'utf8')),
    );
    process.stdout.write(`${JSON.stringify(validation)}\n`);
    if (!validation.valid) process.exitCode = 1;
    return;
  }
  throw new Error('usage: representative-production-runner.mjs manifest|validate ...');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
