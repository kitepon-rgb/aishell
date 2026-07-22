#!/usr/bin/env node

import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { createRepresentativeLocalCallbacks } from './representative-local-callbacks.mjs';
import { createRepresentativeProductionHarness } from './representative-production-harness.mjs';
import {
  buildRepresentativeAttemptManifest,
  validateRepresentativeAttemptManifest,
} from './representative-production-runner.mjs';

async function optionalJSON(file, fallback) {
  try { return JSON.parse(await readFile(file, 'utf8')); }
  catch (error) {
    if (error?.code === 'ENOENT') return fallback;
    throw error;
  }
}

async function atomicJSON(file, value) {
  const temporary = `${file}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`);
  await rename(temporary, file);
}

async function exists(file) {
  try { await stat(file); return true; }
  catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

const configurationFile = process.argv[2];
if (!configurationFile) throw new Error('usage: run-representative-production.mjs <configuration.json>');
const configurationPath = path.resolve(configurationFile);
const configuration = JSON.parse(await readFile(configurationPath, 'utf8'));
const runDirectory = path.resolve(path.dirname(configurationPath), configuration.runDirectory);
const manifestFile = path.join(runDirectory, 'manifest.json');
const checkpointFile = path.join(runDirectory, 'checkpoint.json');
const resultFile = path.join(runDirectory, 'result.json');
await mkdir(runDirectory, { recursive: true });

let manifest;
if (await exists(manifestFile)) {
  manifest = validateRepresentativeAttemptManifest(JSON.parse(await readFile(manifestFile, 'utf8')));
} else {
  manifest = await buildRepresentativeAttemptManifest(configuration.runConfiguration);
  await writeFile(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' });
}
const checkpoint = await optionalJSON(checkpointFile, {
  schema: 'aishell.representative-checkpoint.v1', records: [], oracleRecords: [], metricRecords: [],
});
if (checkpoint.schema !== 'aishell.representative-checkpoint.v1' || !Array.isArray(checkpoint.records)
  || !Array.isArray(checkpoint.oracleRecords) || !Array.isArray(checkpoint.metricRecords)) {
  throw new Error('invalid representative checkpoint');
}
for (let index = 0; index < checkpoint.records.length; index += 1) {
  if (checkpoint.records[index]?.attemptID !== manifest.attempts[index]?.attemptID) {
    throw new Error('checkpoint records are not a frozen manifest prefix');
  }
}
const next = manifest.attempts[checkpoint.records.length];
if (next && await exists(path.join(configuration.executorOptions.outputDirectory, next.attemptID))) {
  throw new Error(`next attempt directory already exists without a completed checkpoint: ${next.attemptID}`);
}

const local = createRepresentativeLocalCallbacks({ armBinaries: configuration.executorOptions.armBinaries });
const harness = createRepresentativeProductionHarness({
  executorOptions: configuration.executorOptions,
  prepareSetup: local.prepareSetup,
  materializePrompt: local.materializePrompt,
  beforeAgentAttempt: local.beforeAgentAttempt,
  afterAgentAttempt: local.afterAgentAttempt,
  validateSetupEvidence: local.validateSetupEvidence,
  exchangeMCP: local.exchangeMCP,
  collectAttemptEvidence: local.collectRepresentativeAttemptEvidence,
  observeProviderModel: local.observeProviderModel,
  runProcess: local.runProcess,
  priorOracleRecords: checkpoint.oracleRecords,
  priorMetricRecords: checkpoint.metricRecords,
});
const records = [...checkpoint.records];
const outcome = await harness.run({
  manifest,
  priorRecords: records,
  onCheckpoint: async ({ record, completed, oracleRecords, metricRecords }) => {
    records.push(record);
    if (records.length !== completed) throw new Error('checkpoint completion count is inconsistent');
    await atomicJSON(checkpointFile, {
      schema: 'aishell.representative-checkpoint.v1', records, oracleRecords, metricRecords,
    });
    process.stderr.write(`completed ${completed}/288: ${record.attemptID}\n`);
  },
});
await atomicJSON(resultFile, outcome.result);
await atomicJSON(path.join(runDirectory, 'oracle-records.json'), outcome.oracleRecords);
await atomicJSON(path.join(runDirectory, 'metric-records.json'), outcome.metricRecords);
process.stdout.write(`${JSON.stringify({
  status: outcome.result.status,
  attempts: outcome.result.attempts.length,
  invalidReasons: outcome.result.invalidReasons,
  resultFile,
})}\n`);
