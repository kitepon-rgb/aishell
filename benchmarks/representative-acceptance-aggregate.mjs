#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { validateRepresentativeAttemptManifest, validateRepresentativeResult } from './representative-production-runner.mjs';

const ARMS = Object.freeze(['native', 'current-aishell-0.3.3', 'candidate']);
const COUNT_METRICS = Object.freeze([
  'toolCalls', 'modelTurns', 'retries', 'artifactRereads', 'filesystemEntriesRescanned',
  'bytesReread', 'processReexecutions', 'cacheHits', 'changeJournalHits',
]);
const FORBIDDEN_TELEMETRY = Object.freeze([
  'silentFallbacks', 'silentTruncations', 'falseFresh', 'silentFullScans',
  'partialWrites', 'silentTextFallbacks', 'silentLexicalFallbacks',
]);

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * "Unverified is never counted as solved": a solved candidate attempt must retain its adapter trace,
 * because the evidence collector always emits one when the root capability call was accepted. A null
 * trace is therefore only admissible on a non-solving candidate attempt (tool non-adoption). Returns
 * the violation message, or null when the attempt is admissible.
 */
export function solvedCandidateTraceViolation(arm, solved, adapterTrace, sequence) {
  return arm === 'candidate' && solved === true && adapterTrace === null
    ? `candidate ${sequence} solved attempt is missing its adapter trace`
    : null;
}

function exactKeys(value, expected, label) {
  if (!plainObject(value)) throw new Error(`${label} must be an object`);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(`${label} has invalid fields`);
  }
}

function nonnegativeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be a nonnegative integer`);
  return value;
}

function quantile(values, probability) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const position = (sorted.length - 1) * probability;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  return lower === upper ? sorted[lower] : sorted[lower] + ((sorted[upper] - sorted[lower]) * (position - lower));
}

function finiteRatio(numerator, denominator) {
  return denominator > 0 ? numerator / denominator : null;
}

function difference(left, right) {
  const available = new Set(right);
  return left.filter((item) => !available.has(item));
}

function aggregateBucket(records, taskCount) {
  const solvedAttempts = records.filter(({ oracle }) => oracle.solved).length;
  const totalModelTokens = records.reduce((sum, { attempt }) => sum + attempt.usage.totalModelTokens, 0);
  const taskGroups = Map.groupBy(records, ({ attempt }) => attempt.taskID);
  const solvedTaskIDs = [...taskGroups].filter(([, attempts]) =>
    attempts.length === 3 && attempts.every(({ oracle }) => oracle.solved)).map(([taskID]) => taskID).sort();
  const totals = Object.fromEntries(COUNT_METRICS.map((key) => [
    key, records.reduce((sum, { metrics }) => sum + metrics[key], 0),
  ]));
  const firstUseful = records.flatMap(({ metrics }) =>
    metrics.firstUsefulResultMilliseconds === null ? [] : [metrics.firstUsefulResultMilliseconds]);
  return {
    attempts: records.length,
    solvedAttempts,
    solvedTasks: solvedTaskIDs.length,
    solvedTaskIDs,
    taskSuccessRate: solvedTaskIDs.length / taskCount,
    totalModelTokens,
    tokensPerSolvedAttempt: solvedAttempts === 0 ? null : totalModelTokens / solvedAttempts,
    tokensPerSolvedTask: solvedTaskIDs.length === 0 ? null : totalModelTokens / solvedTaskIDs.length,
    wallMilliseconds: {
      p50: quantile(records.map(({ attempt }) => attempt.wallMilliseconds), 0.5),
      p95: quantile(records.map(({ attempt }) => attempt.wallMilliseconds), 0.95),
    },
    firstUsefulResultMilliseconds: {
      samples: firstUseful.length,
      p50: quantile(firstUseful, 0.5),
      p95: quantile(firstUseful, 0.95),
    },
    totals,
    toolAdoption: {
      attempts: records.filter(({ metrics }) => metrics.toolAdoption).length,
      rate: records.filter(({ metrics }) => metrics.toolAdoption).length / records.length,
    },
  };
}

export function aggregateValidatedRepresentativeRecords(records) {
  const taskIDs = [...new Set(records.map(({ attempt }) => attempt.taskID))].sort();
  const perTaskArms = taskIDs.flatMap((taskID) => ARMS.map((arm) => ({
    taskID,
    arm,
    ...aggregateBucket(records.filter(({ attempt }) => attempt.taskID === taskID && attempt.arm === arm), 1),
  })));
  const overallArms = ARMS.map((arm) => ({
    arm,
    ...aggregateBucket(records.filter(({ attempt }) => attempt.arm === arm), taskIDs.length),
  }));
  const byArm = Object.fromEntries(overallArms.map((entry) => [entry.arm, entry]));
  const candidateTelemetry = records.filter(({ attempt }) => attempt.arm === 'candidate');
  const forbiddenTelemetry = Object.fromEntries(FORBIDDEN_TELEMETRY.map((key) => [
    key, candidateTelemetry.reduce((sum, { telemetry }) => sum + telemetry[key], 0),
  ]));
  const forbiddenTelemetryTotal = Object.values(forbiddenTelemetry).reduce((sum, value) => sum + value, 0);
  const tokenRatio = finiteRatio(byArm.candidate.tokensPerSolvedTask, byArm.native.tokensPerSolvedTask);
  const correctness = {
    candidateRegressionsFromNative: difference(byArm.native.solvedTaskIDs, byArm.candidate.solvedTaskIDs),
    candidateRegressionsFromCurrent: difference(byArm['current-aishell-0.3.3'].solvedTaskIDs, byArm.candidate.solvedTaskIDs),
  };
  const gate = {
    baselineArm: 'native',
    tokenMetric: 'all_attempt_tokens_per_solved_task',
    tokenReduction: tokenRatio === null ? null : 1 - tokenRatio,
    tokenReductionAtLeast30Percent: tokenRatio !== null && tokenRatio <= 0.70,
    p50NonRegression: byArm.candidate.wallMilliseconds.p50 <= byArm.native.wallMilliseconds.p50,
    p95Within10Percent: byArm.candidate.wallMilliseconds.p95 <= byArm.native.wallMilliseconds.p95 * 1.10,
    correctnessPassed: correctness.candidateRegressionsFromNative.length === 0
      && correctness.candidateRegressionsFromCurrent.length === 0,
    silentFallbacksZero: forbiddenTelemetryTotal === 0,
  };
  gate.passed = gate.tokenReductionAtLeast30Percent && gate.p50NonRegression && gate.p95Within10Percent
    && gate.correctnessPassed && gate.silentFallbacksZero;
  return { overallArms, perTaskArms, correctness, forbiddenTelemetry, forbiddenTelemetryTotal, gate };
}

function validateMetric(metrics, label) {
  exactKeys(metrics, ['firstUsefulResultMilliseconds', ...COUNT_METRICS, 'toolAdoption'], label);
  if (metrics.firstUsefulResultMilliseconds !== null) {
    nonnegativeInteger(metrics.firstUsefulResultMilliseconds, `${label}.firstUsefulResultMilliseconds`);
  }
  for (const key of COUNT_METRICS) nonnegativeInteger(metrics[key], `${label}.${key}`);
  if (typeof metrics.toolAdoption !== 'boolean') throw new Error(`${label}.toolAdoption must be boolean`);
}

async function candidateTelemetry(manifest, attemptsDirectory) {
  const records = new Map();
  for (const attempt of manifest.attempts.filter(({ arm }) => arm === 'candidate')) {
    const telemetry = JSON.parse(await readFile(path.join(attemptsDirectory, attempt.attemptID, 'observer-telemetry.json'), 'utf8'));
    for (const key of FORBIDDEN_TELEMETRY) nonnegativeInteger(telemetry[key], `${attempt.attemptID}.${key}`);
    records.set(attempt.sequence, telemetry);
  }
  return records;
}

export async function aggregateRepresentativeAcceptance({ manifest, result, oracleRecords, metricRecords, attemptsDirectory }) {
  try {
    validateRepresentativeAttemptManifest(manifest);
    const validation = validateRepresentativeResult(result, manifest);
    if (!validation.valid || result.status !== 'valid') throw new Error(`representative result invalid: ${validation.reasons.join('; ')}`);
    if (!Array.isArray(oracleRecords) || oracleRecords.length !== 288
      || !Array.isArray(metricRecords) || metricRecords.length !== 288) throw new Error('oracle and metric records must contain 288 entries');
    const oracles = new Map(oracleRecords.map((record) => [record.sequence, record.result]));
    const metrics = new Map(metricRecords.map((record) => [record.sequence, record.metrics]));
    if (oracles.size !== 288 || metrics.size !== 288) throw new Error('oracle or metric sequence is duplicate');
    const telemetry = await candidateTelemetry(manifest, attemptsDirectory);
    const resultBySequence = new Map(result.attempts.map((attempt) => [attempt.sequence, attempt]));
    const records = manifest.attempts.map((expected) => {
      const attempt = resultBySequence.get(expected.sequence);
      const oracle = oracles.get(expected.sequence);
      const metric = metrics.get(expected.sequence);
      exactKeys(oracle, ['schema', 'taskId', 'arm', 'solved', 'failures'], `oracle ${expected.sequence}`);
      if (oracle.schema !== 'aishell.capability-oracle-result.v1' || oracle.taskId !== expected.taskID
        || oracle.arm !== expected.arm || typeof oracle.solved !== 'boolean' || !Array.isArray(oracle.failures)
        || (oracle.solved ? oracle.failures.length !== 0 : oracle.failures.length === 0)) {
        throw new Error(`oracle ${expected.sequence} differs from manifest`);
      }
      validateMetric(metric, `metrics ${expected.sequence}`);
      const traceViolation = solvedCandidateTraceViolation(expected.arm, oracle.solved, attempt.adapterTrace, expected.sequence);
      if (traceViolation) throw new Error(traceViolation);
      return { attempt, oracle, metrics: metric, telemetry: expected.arm === 'candidate' ? telemetry.get(expected.sequence) : null };
    });
    const aggregate = aggregateValidatedRepresentativeRecords(records);
    return {
      schema: 'aishell.representative-acceptance-report.v1', status: 'valid', invalidReasons: [],
      replacementPolicy: 'forbidden', ...aggregate,
    };
  } catch (error) {
    return {
      schema: 'aishell.representative-acceptance-report.v1', status: 'invalid', invalidReasons: [error.message],
      replacementPolicy: 'forbidden', overallArms: null, perTaskArms: null, correctness: null,
      forbiddenTelemetry: null, forbiddenTelemetryTotal: null, gate: null,
    };
  }
}

async function main() {
  const [manifestPath, resultPath, oraclePath, metricsPath, attemptsDirectory] = process.argv.slice(2);
  if (!manifestPath || !resultPath || !oraclePath || !metricsPath || !attemptsDirectory) {
    throw new Error('usage: representative-acceptance-aggregate.mjs <manifest> <result> <oracles> <metrics> <attempts-directory>');
  }
  const report = await aggregateRepresentativeAcceptance({
    manifest: JSON.parse(await readFile(manifestPath, 'utf8')),
    result: JSON.parse(await readFile(resultPath, 'utf8')),
    oracleRecords: JSON.parse(await readFile(oraclePath, 'utf8')),
    metricRecords: JSON.parse(await readFile(metricsPath, 'utf8')),
    attemptsDirectory: path.resolve(attemptsDirectory),
  });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (report.status !== 'valid' || !report.gate.passed) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
