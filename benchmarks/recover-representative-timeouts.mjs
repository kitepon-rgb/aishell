#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

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
  const [sourceRunArgument, targetConfigurationArgument] = process.argv.slice(2);
  if (!sourceRunArgument || !targetConfigurationArgument) {
    throw new Error('usage: recover-representative-timeouts.mjs <source-run-directory> <target-configuration.json>');
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
  for (const record of recoveryCheckpoint.recoveredRecords) {
    const target = targetBySequence.get(record?.sequence);
    if (!target || record.attemptID !== target.attemptID || recoveredBySequence.has(record.sequence)) {
      throw new Error('recovery checkpoint does not match timeout targets');
    }
    recoveredBySequence.set(record.sequence, record);
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
    priorOracleRecords: sourceCheckpoint.oracleRecords,
    priorMetricRecords: sourceCheckpoint.metricRecords,
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
