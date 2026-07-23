#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { evaluateAttempt } from './evaluate-capability-oracle.mjs';
import { observedToolCalls, observerMetrics } from './phase3-local-callbacks.mjs';
import { createRepresentativeLocalCallbacks } from './representative-local-callbacks.mjs';
import { createRepresentativeProductionHarness } from './representative-production-harness.mjs';
import {
  buildRepresentativeAttemptManifest,
  validateRepresentativeAttemptManifest,
} from './representative-production-runner.mjs';
import { renderRepresentativePrompt } from './render-representative-prompt.mjs';
import { canonicalJSONBytes, sha256Hex } from './production-v2-benchmark-adapter.mjs';

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function selectTimeoutRecoveryRecords(records) {
  if (!Array.isArray(records) || records.length === 0) throw new Error('source records are required');
  const selected = [];
  for (const [index, record] of records.entries()) {
    if (!plainObject(record) || record.sequence !== index + 1 || typeof record.attemptID !== 'string') {
      throw new Error(`source record ${index + 1} is invalid`);
    }
    if (record.timedOut === true) {
      if (record.usage !== null) throw new Error(`timed-out record ${index + 1} unexpectedly has complete usage`);
      selected.push(record);
    } else if (!plainObject(record.usage)) {
      throw new Error(`non-timeout record ${index + 1} lacks provider usage`);
    }
  }
  if (selected.length === 0) throw new Error('source run has no timeout records to recover');
  return selected;
}

export function mergeRecoveredRecords(sourceRecords, recoveredRecords) {
  const targets = new Map(selectTimeoutRecoveryRecords(sourceRecords).map((record) => [record.sequence, record]));
  if (!Array.isArray(recoveredRecords) || recoveredRecords.length !== targets.size) {
    throw new Error('recovered record set is incomplete');
  }
  const replacements = new Map();
  for (const record of recoveredRecords) {
    const target = targets.get(record?.sequence);
    if (!target || record.attemptID !== target.attemptID || record.timedOut !== false || !plainObject(record.usage)) {
      throw new Error(`recovered record ${record?.sequence ?? 'unknown'} is invalid`);
    }
    if (replacements.has(record.sequence)) throw new Error(`recovered record ${record.sequence} is duplicated`);
    replacements.set(record.sequence, record);
  }
  return sourceRecords.map((record) => replacements.get(record.sequence) ?? record);
}

export function addRecoveryCheckpointRecords(recoveredBySequence, targetBySequence, records) {
  if (!(recoveredBySequence instanceof Map) || !(targetBySequence instanceof Map) || !Array.isArray(records)) {
    throw new Error('recovery checkpoint inputs are invalid');
  }
  for (const record of records) {
    const target = targetBySequence.get(record?.sequence);
    if (!target || record.attemptID !== target.attemptID || recoveredBySequence.has(record.sequence)
      || record.timedOut !== false || !plainObject(record.usage)) {
      throw new Error('recovery checkpoint record is invalid or duplicated');
    }
    recoveredBySequence.set(record.sequence, record);
  }
  return recoveredBySequence;
}

async function readJSON(file) {
  return JSON.parse(await readFile(file, 'utf8'));
}

async function atomicJSON(file, value) {
  const temporary = `${file}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`);
  await rename(temporary, file);
}

async function optionalJSON(file, fallback) {
  try { return await readJSON(file); }
  catch (error) {
    if (error?.code === 'ENOENT') return fallback;
    throw error;
  }
}

async function main() {
  const [sourceRunArgument, targetConfigurationArgument, seedConfigurationArgument] = process.argv.slice(2);
  if (!sourceRunArgument || !targetConfigurationArgument) {
    throw new Error('usage: recover-representative-timeouts.mjs <source-run-directory> <target-configuration.json> [seed-recovery-configuration.json]');
  }
  const sourceRunDirectory = path.resolve(sourceRunArgument);
  const targetConfigurationPath = path.resolve(targetConfigurationArgument);
  const targetConfiguration = await readJSON(targetConfigurationPath);
  const targetRunDirectory = path.resolve(path.dirname(targetConfigurationPath), targetConfiguration.runDirectory);
  const sourceManifest = validateRepresentativeAttemptManifest(await readJSON(path.join(sourceRunDirectory, 'manifest.json')));
  const targetManifest = await buildRepresentativeAttemptManifest(targetConfiguration.runConfiguration);
  if (!canonicalJSONBytes(sourceManifest).equals(canonicalJSONBytes(targetManifest))) {
    throw new Error('target run manifest differs from source run');
  }
  const sourceCheckpoint = await readJSON(path.join(sourceRunDirectory, 'checkpoint.json'));
  if (sourceCheckpoint?.schema !== 'aishell.representative-checkpoint.v1') throw new Error('source checkpoint is invalid');
  const timeoutRecords = selectTimeoutRecoveryRecords(sourceCheckpoint.records);
  const sourceTimeout = Number((await readJSON(path.join(path.dirname(sourceRunDirectory), 'configuration.json')))
    .executorOptions?.timeoutMilliseconds);
  const targetTimeout = Number(targetConfiguration.executorOptions?.timeoutMilliseconds);
  if (!Number.isSafeInteger(sourceTimeout) || !Number.isSafeInteger(targetTimeout) || targetTimeout <= sourceTimeout) {
    throw new Error('target timeout must be greater than source timeout');
  }

  await mkdir(targetRunDirectory, { recursive: true });
  await mkdir(targetConfiguration.executorOptions.outputDirectory, { recursive: true });
  const recoveryCheckpointFile = path.join(targetRunDirectory, 'recovery-checkpoint.json');
  const recoveryCheckpoint = await optionalJSON(recoveryCheckpointFile, {
    schema: 'aishell.representative-timeout-recovery-checkpoint.v1', recoveredRecords: [],
  });
  if (recoveryCheckpoint?.schema !== 'aishell.representative-timeout-recovery-checkpoint.v1'
    || !Array.isArray(recoveryCheckpoint.recoveredRecords)) throw new Error('recovery checkpoint is invalid');
  const targetBySequence = new Map(timeoutRecords.map((record) => [record.sequence, record]));
  const recoveredBySequence = new Map();
  const recoveredEvidenceDirectoryBySequence = new Map();
  let seededRecoveryCount = 0;
  for (const record of recoveryCheckpoint.recoveredRecords) {
    const target = targetBySequence.get(record?.sequence);
    if (!target || record.attemptID !== target.attemptID || recoveredBySequence.has(record.sequence)) {
      throw new Error('recovery checkpoint does not match timeout targets');
    }
    recoveredBySequence.set(record.sequence, record);
    recoveredEvidenceDirectoryBySequence.set(record.sequence, targetConfiguration.executorOptions.outputDirectory);
  }
  if (seedConfigurationArgument) {
    const seedConfigurationPath = path.resolve(seedConfigurationArgument);
    const seedConfiguration = await readJSON(seedConfigurationPath);
    const seedManifest = await buildRepresentativeAttemptManifest(seedConfiguration.runConfiguration);
    if (!canonicalJSONBytes(seedManifest).equals(canonicalJSONBytes(targetManifest))) {
      throw new Error('seed recovery manifest differs from target run');
    }
    const seedRunDirectory = path.resolve(path.dirname(seedConfigurationPath), seedConfiguration.runDirectory);
    const seedCheckpoint = await readJSON(path.join(seedRunDirectory, 'recovery-checkpoint.json'));
    if (seedCheckpoint?.schema !== 'aishell.representative-timeout-recovery-checkpoint.v1'
      || !Array.isArray(seedCheckpoint.recoveredRecords)) throw new Error('seed recovery checkpoint is invalid');
    addRecoveryCheckpointRecords(recoveredBySequence, targetBySequence, seedCheckpoint.recoveredRecords);
    for (const record of seedCheckpoint.recoveredRecords) {
      recoveredEvidenceDirectoryBySequence.set(record.sequence, seedConfiguration.executorOptions.outputDirectory);
      seededRecoveryCount += 1;
    }
    await atomicJSON(recoveryCheckpointFile, {
      schema: 'aishell.representative-timeout-recovery-checkpoint.v1',
      recoveredRecords: [...recoveredBySequence.values()].sort((a, b) => a.sequence - b.sequence),
    });
  }

  const priorOracleRecords = new Map(sourceCheckpoint.oracleRecords.map((record) => [record.sequence, record]));
  const priorMetricRecords = new Map(sourceCheckpoint.metricRecords.map((record) => [record.sequence, record]));
  for (const record of recoveredBySequence.values()) {
    const attempt = targetManifest.attempts[record.sequence - 1];
    const evidenceRoot = recoveredEvidenceDirectoryBySequence.get(record.sequence);
    const attemptDirectory = path.join(evidenceRoot, record.attemptID);
    const actual = await readJSON(path.join(attemptDirectory, 'observer-evidence.json'));
    const oracle = await evaluateAttempt({ taskId: attempt.taskID, armId: attempt.arm, actual });
    const events = (await readFile(path.join(attemptDirectory, 'provider-events.jsonl'), 'utf8'))
      .split('\n').filter(Boolean).map(JSON.parse);
    const calls = await observedToolCalls(events,
      attempt.arm === 'native' ? undefined : path.join(attemptDirectory, 'mcp-wire'));
    priorOracleRecords.set(record.sequence, { sequence: record.sequence, result: oracle });
    priorMetricRecords.set(record.sequence, { sequence: record.sequence, metrics: observerMetrics(events, calls, attempt) });
  }

  const local = createRepresentativeLocalCallbacks({ armBinaries: targetConfiguration.executorOptions.armBinaries });
  const harness = createRepresentativeProductionHarness({
    executorOptions: targetConfiguration.executorOptions,
    prepareSetup: local.prepareSetup,
    materializePrompt: local.materializePrompt,
    beforeAgentAttempt: local.beforeAgentAttempt,
    afterAgentAttempt: local.afterAgentAttempt,
    validateSetupEvidence: local.validateSetupEvidence,
    exchangeMCP: local.exchangeMCP,
    collectAttemptEvidence: local.collectRepresentativeAttemptEvidence,
    observeProviderModel: local.observeProviderModel,
    runProcess: local.runProcess,
    priorOracleRecords: [...priorOracleRecords.values()].sort((a, b) => a.sequence - b.sequence),
    priorMetricRecords: [...priorMetricRecords.values()].sort((a, b) => a.sequence - b.sequence),
  });
  for (const target of timeoutRecords) {
    if (recoveredBySequence.has(target.sequence)) continue;
    const attempt = targetManifest.attempts[target.sequence - 1];
    const prompt = await renderRepresentativePrompt(attempt.taskID, { materializeModelParameters: true });
    if (sha256Hex(Buffer.from(prompt, 'utf8')) !== attempt.promptSHA256) {
      throw new Error(`prompt binding changed: ${attempt.attemptID}`);
    }
    const recovered = await harness.executor(Object.freeze({
      attempt: structuredClone(attempt), isolation: structuredClone(targetManifest.isolation),
      armBinding: structuredClone(targetManifest.armBindings[attempt.arm]), prompt,
    }));
    if (recovered.timedOut !== false || !plainObject(recovered.usage)) {
      throw new Error(`recovery attempt did not complete: ${attempt.attemptID}`);
    }
    recoveredBySequence.set(recovered.sequence, recovered);
    await atomicJSON(recoveryCheckpointFile, {
      schema: 'aishell.representative-timeout-recovery-checkpoint.v1',
      recoveredRecords: [...recoveredBySequence.values()].sort((a, b) => a.sequence - b.sequence),
    });
    process.stderr.write(`recovered ${recoveredBySequence.size}/${timeoutRecords.length}: ${attempt.attemptID}\n`);
  }

  const records = mergeRecoveredRecords(sourceCheckpoint.records, [...recoveredBySequence.values()]);
  const outcome = await harness.run({ manifest: targetManifest, priorRecords: records });
  await atomicJSON(path.join(targetRunDirectory, 'manifest.json'), targetManifest);
  await atomicJSON(path.join(targetRunDirectory, 'checkpoint.json'), {
    schema: 'aishell.representative-checkpoint.v1', records,
    oracleRecords: outcome.oracleRecords, metricRecords: outcome.metricRecords,
  });
  await atomicJSON(path.join(targetRunDirectory, 'result.json'), outcome.result);
  await atomicJSON(path.join(targetRunDirectory, 'oracle-records.json'), outcome.oracleRecords);
  await atomicJSON(path.join(targetRunDirectory, 'metric-records.json'), outcome.metricRecords);
  const sourceResultBytes = await readFile(path.join(sourceRunDirectory, 'result.json'));
  await atomicJSON(path.join(targetRunDirectory, 'recovery-receipt.json'), {
    schema: 'aishell.representative-timeout-recovery-receipt.v1',
    sourceResultSHA256: createHash('sha256').update(sourceResultBytes).digest('hex'),
    manifestSHA256: sha256Hex(canonicalJSONBytes(targetManifest)),
    sourceTimeoutMilliseconds: sourceTimeout,
    targetTimeoutMilliseconds: targetTimeout,
    reusedRecordCount: records.length - timeoutRecords.length,
    seededRecoveryCount,
    recoveredSequences: timeoutRecords.map(({ sequence }) => sequence),
    resultStatus: outcome.result.status,
  });
  process.stdout.write(`${JSON.stringify({
    status: outcome.result.status,
    recovered: timeoutRecords.length,
    reused: records.length - timeoutRecords.length,
    resultFile: path.join(targetRunDirectory, 'result.json'),
  })}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
