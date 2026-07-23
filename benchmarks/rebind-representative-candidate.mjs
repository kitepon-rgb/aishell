#!/usr/bin/env node

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { evaluateAttempt } from './evaluate-capability-oracle.mjs';
import { observedToolCalls, observerMetrics } from './phase3-local-callbacks.mjs';
import { canonicalJSONBytes, sha256Hex } from './production-v2-benchmark-adapter.mjs';
import { ensureRepresentativeBinaryBindings } from './representative-binary-bindings.mjs';
import { createRepresentativeLocalCallbacks } from './representative-local-callbacks.mjs';
import { createRepresentativeProductionHarness } from './representative-production-harness.mjs';
import {
  buildRepresentativeAttemptManifest,
  validateRepresentativeAttemptManifest,
} from './representative-production-runner.mjs';
import { renderRepresentativePrompt } from './render-representative-prompt.mjs';

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

async function readJSON(file) {
  return JSON.parse(await readFile(file, 'utf8'));
}

async function atomicJSON(file, value) {
  const temporary = `${file}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`);
  await rename(temporary, file);
}

export function validateCandidateRebindManifests(sourceManifest, targetManifest) {
  validateRepresentativeAttemptManifest(sourceManifest);
  validateRepresentativeAttemptManifest(targetManifest);
  const normalized = structuredClone(targetManifest);
  normalized.armBindings.candidate = structuredClone(sourceManifest.armBindings.candidate);
  for (let index = 0; index < normalized.attempts.length; index += 1) {
    if (normalized.attempts[index].arm === 'candidate') {
      normalized.attempts[index].armBindingSHA256 = sourceManifest.attempts[index].armBindingSHA256;
    }
  }
  if (!canonicalJSONBytes(normalized).equals(canonicalJSONBytes(sourceManifest))) {
    throw new Error('target manifest differs beyond the candidate binding');
  }
  if (canonicalJSONBytes(targetManifest.armBindings.candidate)
    .equals(canonicalJSONBytes(sourceManifest.armBindings.candidate))) {
    throw new Error('candidate binding did not change');
  }
  return targetManifest;
}

export function mergeCandidateRebindPrefix({ sourceManifest, sourceRecords, recoveredRecords }) {
  if (!Array.isArray(sourceRecords) || sourceRecords.length < 1
    || sourceRecords.length > sourceManifest.attempts.length || !Array.isArray(recoveredRecords)) {
    throw new Error('candidate rebind records are invalid');
  }
  const recovered = new Map();
  for (const record of recoveredRecords) {
    const attempt = sourceManifest.attempts[record?.sequence - 1];
    if (!attempt || attempt.sequence > sourceRecords.length || attempt.arm !== 'candidate'
      || record.attemptID !== attempt.attemptID || recovered.has(record.sequence)
      || record.timedOut !== false || !plainObject(record.usage)) {
      throw new Error('recovered candidate record is invalid or duplicated');
    }
    recovered.set(record.sequence, record);
  }
  return sourceRecords.map((record, index) => {
    const attempt = sourceManifest.attempts[index];
    if (record?.attemptID !== attempt.attemptID) throw new Error('source records are not a frozen manifest prefix');
    if (attempt.arm !== 'candidate') return record;
    const replacement = recovered.get(attempt.sequence);
    if (!replacement) throw new Error(`candidate recovery is incomplete: ${attempt.attemptID}`);
    return replacement;
  });
}

async function main() {
  const [sourceRunArgument, targetConfigurationArgument] = process.argv.slice(2);
  if (!sourceRunArgument || !targetConfigurationArgument) {
    throw new Error('usage: rebind-representative-candidate.mjs <source-run-directory> <target-configuration.json>');
  }
  const sourceRunDirectory = path.resolve(sourceRunArgument);
  const targetConfigurationPath = path.resolve(targetConfigurationArgument);
  const targetConfiguration = await readJSON(targetConfigurationPath);
  const targetRunDirectory = path.resolve(path.dirname(targetConfigurationPath), targetConfiguration.runDirectory);
  const sourceManifest = validateRepresentativeAttemptManifest(await readJSON(path.join(sourceRunDirectory, 'manifest.json')));
  const targetManifest = validateCandidateRebindManifests(
    sourceManifest,
    await buildRepresentativeAttemptManifest(targetConfiguration.runConfiguration),
  );
  const sourceCheckpoint = await readJSON(path.join(sourceRunDirectory, 'checkpoint.json'));
  if (sourceCheckpoint?.schema !== 'aishell.representative-checkpoint.v1'
    || !Array.isArray(sourceCheckpoint.records) || !Array.isArray(sourceCheckpoint.oracleRecords)
    || !Array.isArray(sourceCheckpoint.metricRecords)
    || sourceCheckpoint.records.length !== sourceCheckpoint.oracleRecords.length
    || sourceCheckpoint.records.length !== sourceCheckpoint.metricRecords.length) {
    throw new Error('source checkpoint is invalid');
  }

  await mkdir(targetRunDirectory, { recursive: true });
  await mkdir(targetConfiguration.executorOptions.outputDirectory, { recursive: true });
  await atomicJSON(path.join(targetRunDirectory, 'manifest.json'), targetManifest);
  const frozenArmBinaries = await ensureRepresentativeBinaryBindings({
    manifest: targetManifest,
    armBinaries: targetConfiguration.executorOptions.armBinaries,
    bindingsDirectory: path.join(targetRunDirectory, 'bindings'),
  });
  const executorOptions = { ...targetConfiguration.executorOptions, armBinaries: frozenArmBinaries };
  const local = createRepresentativeLocalCallbacks({ armBinaries: frozenArmBinaries });
  const harness = createRepresentativeProductionHarness({
    executorOptions,
    prepareSetup: local.prepareSetup,
    materializePrompt: local.materializePrompt,
    beforeAgentAttempt: local.beforeAgentAttempt,
    afterAgentAttempt: local.afterAgentAttempt,
    validateSetupEvidence: local.validateSetupEvidence,
    exchangeMCP: local.exchangeMCP,
    collectAttemptEvidence: local.collectRepresentativeAttemptEvidence,
    observeProviderModel: local.observeProviderModel,
    runProcess: local.runProcess,
  });

  const recoveryCheckpointFile = path.join(targetRunDirectory, 'candidate-rebind-checkpoint.json');
  let recoveryCheckpoint;
  try {
    recoveryCheckpoint = await readJSON(recoveryCheckpointFile);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    recoveryCheckpoint = { schema: 'aishell.representative-candidate-rebind-checkpoint.v1', entries: [] };
  }
  if (recoveryCheckpoint?.schema !== 'aishell.representative-candidate-rebind-checkpoint.v1'
    || !Array.isArray(recoveryCheckpoint.entries)) throw new Error('candidate rebind checkpoint is invalid');
  const entries = new Map();
  for (const entry of recoveryCheckpoint.entries) {
    if (!plainObject(entry) || !plainObject(entry.record) || !plainObject(entry.oracleRecord)
      || !plainObject(entry.metricRecord) || entries.has(entry.record.sequence)
      || entry.oracleRecord.sequence !== entry.record.sequence || entry.metricRecord.sequence !== entry.record.sequence) {
      throw new Error('candidate rebind checkpoint entry is invalid or duplicated');
    }
    entries.set(entry.record.sequence, entry);
  }

  const candidateAttempts = targetManifest.attempts
    .slice(0, sourceCheckpoint.records.length).filter(({ arm }) => arm === 'candidate');
  for (const attempt of candidateAttempts) {
    if (entries.has(attempt.sequence)) continue;
    const prompt = await renderRepresentativePrompt(attempt.taskID, { materializeModelParameters: true });
    if (sha256Hex(Buffer.from(prompt, 'utf8')) !== attempt.promptSHA256) {
      throw new Error(`prompt binding changed: ${attempt.attemptID}`);
    }
    const record = await harness.executor(Object.freeze({
      attempt: structuredClone(attempt),
      isolation: structuredClone(targetManifest.isolation),
      armBinding: structuredClone(targetManifest.armBindings.candidate),
      prompt,
    }));
    const attemptDirectory = path.join(executorOptions.outputDirectory, attempt.attemptID);
    const actual = await readJSON(path.join(attemptDirectory, 'observer-evidence.json'));
    const oracleRecord = {
      sequence: attempt.sequence,
      result: await evaluateAttempt({ taskId: attempt.taskID, armId: attempt.arm, actual }),
    };
    const events = (await readFile(path.join(attemptDirectory, 'provider-events.jsonl'), 'utf8'))
      .split('\n').filter(Boolean).map(JSON.parse);
    const calls = await observedToolCalls(events, path.join(attemptDirectory, 'mcp-wire'));
    const metricRecord = { sequence: attempt.sequence, metrics: observerMetrics(events, calls, attempt) };
    entries.set(attempt.sequence, { record, oracleRecord, metricRecord });
    await atomicJSON(recoveryCheckpointFile, {
      schema: 'aishell.representative-candidate-rebind-checkpoint.v1',
      entries: [...entries.values()].sort((left, right) => left.record.sequence - right.record.sequence),
    });
    process.stderr.write(`rebound ${entries.size}/${candidateAttempts.length}: ${attempt.attemptID}\n`);
  }

  const recoveredEntries = [...entries.values()];
  const records = mergeCandidateRebindPrefix({
    sourceManifest,
    sourceRecords: sourceCheckpoint.records,
    recoveredRecords: recoveredEntries.map(({ record }) => record),
  });
  const replacementOracles = new Map(recoveredEntries.map(({ oracleRecord }) => [oracleRecord.sequence, oracleRecord]));
  const replacementMetrics = new Map(recoveredEntries.map(({ metricRecord }) => [metricRecord.sequence, metricRecord]));
  const oracleRecords = sourceCheckpoint.oracleRecords.map((record) => replacementOracles.get(record.sequence) ?? record);
  const metricRecords = sourceCheckpoint.metricRecords.map((record) => replacementMetrics.get(record.sequence) ?? record);
  await atomicJSON(path.join(targetRunDirectory, 'checkpoint.json'), {
    schema: 'aishell.representative-checkpoint.v1', records, oracleRecords, metricRecords,
  });
  process.stdout.write(`${JSON.stringify({
    schema: 'aishell.representative-candidate-rebind-result.v1',
    rebound: candidateAttempts.length,
    reused: records.length - candidateAttempts.length,
    completedPrefix: records.length,
    checkpointFile: path.join(targetRunDirectory, 'checkpoint.json'),
  })}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
