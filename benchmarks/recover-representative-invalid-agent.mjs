#!/usr/bin/env node

import { readFile, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { observedToolCalls, observerMetrics } from './phase3-local-callbacks.mjs';
import {
  extractProviderModelsFromSSETrace,
  extractProviderUsageFromSSETrace,
} from './phase3-representative-runner.mjs';
import { canonicalJSONBytes, sha256Hex } from './production-v2-benchmark-adapter.mjs';
import { invalidAgentOracle } from './representative-production-harness.mjs';
import { validateRepresentativeAttemptManifest } from './representative-production-runner.mjs';

async function readJSON(file) {
  return JSON.parse(await readFile(file, 'utf8'));
}

async function atomicJSON(file, value) {
  const temporary = `${file}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`);
  await rename(temporary, file);
}

function exactByteBinding(value) {
  const bytes = Buffer.from(value);
  return {
    encoding: 'base64',
    base64: bytes.toString('base64'),
    byteLength: bytes.length,
    sha256: sha256Hex(bytes),
  };
}

const configurationPath = process.argv[2] && path.resolve(process.argv[2]);
if (!configurationPath) {
  throw new Error('usage: recover-representative-invalid-agent.mjs <configuration.json>');
}
const configuration = await readJSON(configurationPath);
const runDirectory = path.resolve(path.dirname(configurationPath), configuration.runDirectory);
const manifest = validateRepresentativeAttemptManifest(await readJSON(path.join(runDirectory, 'manifest.json')));
const checkpointFile = path.join(runDirectory, 'checkpoint.json');
const checkpoint = await readJSON(checkpointFile);
if (checkpoint?.schema !== 'aishell.representative-checkpoint.v1'
  || !Array.isArray(checkpoint.records) || !Array.isArray(checkpoint.oracleRecords)
  || !Array.isArray(checkpoint.metricRecords)
  || checkpoint.records.length !== checkpoint.oracleRecords.length
  || checkpoint.records.length !== checkpoint.metricRecords.length) {
  throw new Error('representative checkpoint is invalid');
}
const attempt = manifest.attempts[checkpoint.records.length];
if (!attempt || attempt.arm === 'candidate') {
  throw new Error('next attempt is unavailable or candidate recovery requires adapter evidence');
}
const attemptDirectory = path.join(configuration.executorOptions.outputDirectory, attempt.attemptID);
const agentResultFile = path.join(attemptDirectory, 'agent-result.json');
const agentResultBytes = await readFile(agentResultFile);
const agentResult = JSON.parse(agentResultBytes);
const oracle = invalidAgentOracle(attempt, agentResult);
if (oracle === null) throw new Error('next attempt does not contain an invalid agent report');

const providerTraceBytes = await readFile(path.join(attemptDirectory, 'provider-events.jsonl'));
const providerSSEBytes = await readFile(path.join(attemptDirectory, 'provider-sse.jsonl'));
const extractedUsage = extractProviderUsageFromSSETrace(providerSSEBytes);
const providerModels = extractProviderModelsFromSSETrace(providerSSEBytes);
const events = providerTraceBytes.toString('utf8').split('\n').filter(Boolean).map(JSON.parse);
const calls = await observedToolCalls(events, path.join(attemptDirectory, 'mcp-wire'));
const metricRecord = { sequence: attempt.sequence, metrics: observerMetrics(events, calls, attempt) };

let execution;
let executionSource;
try {
  execution = await readJSON(path.join(attemptDirectory, 'execution-result.json'));
  executionSource = 'execution-result.json';
} catch (error) {
  if (error?.code !== 'ENOENT') throw error;
  const start = await stat(path.join(attemptDirectory, 'codex-invocation.json'));
  const end = await stat(path.join(attemptDirectory, 'provider-events.jsonl'));
  execution = {
    exitCode: 0,
    timedOut: false,
    wallMilliseconds: Math.max(0, Math.round(end.mtimeMs - start.mtimeMs)),
  };
  executionSource = 'inferred from codex-invocation/provider-events mtimes; non-timeout path reached provider evidence';
}
if (execution.exitCode !== 0 || execution.timedOut !== false
  || !Number.isSafeInteger(execution.wallMilliseconds) || execution.wallMilliseconds < 0) {
  throw new Error('invalid agent execution recovery evidence is invalid');
}

const record = {
  attemptID: attempt.attemptID,
  sequence: attempt.sequence,
  taskID: attempt.taskID,
  arm: attempt.arm,
  repetition: attempt.repetition,
  usage: extractedUsage.usage,
  providerTrace: exactByteBinding(providerTraceBytes),
  providerSSE: exactByteBinding(providerSSEBytes),
  providerModels,
  providerUsageFormat: extractedUsage.format,
  agentResult: exactByteBinding(agentResultBytes),
  adapterTrace: null,
  agentExitCode: execution.exitCode,
  timedOut: execution.timedOut,
  wallMilliseconds: execution.wallMilliseconds,
};
checkpoint.records.push(record);
checkpoint.oracleRecords.push({ sequence: attempt.sequence, result: oracle });
checkpoint.metricRecords.push(metricRecord);
await atomicJSON(checkpointFile, checkpoint);
await atomicJSON(path.join(attemptDirectory, 'invalid-agent-recovery-receipt.json'), {
  schema: 'aishell.representative-invalid-agent-recovery-receipt.v1',
  attemptID: attempt.attemptID,
  sequence: attempt.sequence,
  reason: agentResult.reason,
  executionSource,
  execution,
  usageSHA256: sha256Hex(canonicalJSONBytes(extractedUsage.usage)),
  recordSHA256: sha256Hex(canonicalJSONBytes(record)),
  replacementAttemptExecuted: false,
});
process.stdout.write(`${JSON.stringify({
  schema: 'aishell.representative-invalid-agent-recovery-result.v1',
  recoveredSequence: attempt.sequence,
  completed: checkpoint.records.length,
  replacementAttemptExecuted: false,
})}\n`);
