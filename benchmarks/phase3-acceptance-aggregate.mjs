#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { validatePhase3AttemptManifest, validatePhase3Result } from './phase3-representative-runner.mjs';

const TASKS = Object.freeze([
  'freshness-cache-repeat-check',
  'freshness-cache-input-change',
  'change-impact-direct-dependent',
  'change-impact-unresolved-edge',
  'focused-pipeline-recommend-only',
  'focused-pipeline-explicit-run',
]);
const ARMS = Object.freeze(['native', 'current-aishell-0.3.3', 'candidate']);
const REPETITIONS = Object.freeze([1, 2, 3]);
const COUNT_METRICS = Object.freeze([
  'toolCalls', 'modelTurns', 'retries', 'artifactRereads', 'filesystemEntriesRescanned',
  'bytesReread', 'processReexecutions', 'cacheHits', 'changeJournalHits',
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

function tupleKey({ taskID, arm, repetition }) {
  return `${taskID}\0${arm}\0${repetition}`;
}

function expectedTupleKeys() {
  return new Set(TASKS.flatMap((taskID) => ARMS.flatMap((arm) =>
    REPETITIONS.map((repetition) => tupleKey({ taskID, arm, repetition })))))
}

function nonnegativeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be a nonnegative safe integer`);
  return value;
}

function validateUsage(usage, label) {
  exactKeys(usage, [
    'source', 'inputTokens', 'cachedInputTokens', 'outputTokens', 'reasoningOutputTokens', 'totalModelTokens',
  ], label);
  if (usage.source !== 'provider') throw new Error(`${label} must be provider-reported`);
  for (const key of ['inputTokens', 'cachedInputTokens', 'outputTokens', 'reasoningOutputTokens', 'totalModelTokens']) {
    nonnegativeInteger(usage[key], `${label}.${key}`);
  }
  if (usage.cachedInputTokens > usage.inputTokens || usage.reasoningOutputTokens > usage.outputTokens
    || usage.totalModelTokens !== usage.inputTokens + usage.outputTokens) {
    throw new Error(`${label} token accounting is inconsistent`);
  }
}

function validateMetricRecord(metrics, label) {
  exactKeys(metrics, ['firstUsefulResultMilliseconds', ...COUNT_METRICS, 'toolAdoption'], label);
  if (metrics.firstUsefulResultMilliseconds !== null) {
    nonnegativeInteger(metrics.firstUsefulResultMilliseconds, `${label}.firstUsefulResultMilliseconds`);
  }
  for (const key of COUNT_METRICS) nonnegativeInteger(metrics[key], `${label}.${key}`);
  if (typeof metrics.toolAdoption !== 'boolean') throw new Error(`${label}.toolAdoption must be boolean`);
}

function recordsBySequence(records, label, expectedKeys) {
  if (!Array.isArray(records) || records.length !== 54) throw new Error(`${label} must contain exactly 54 records`);
  const bySequence = new Map();
  for (const [index, record] of records.entries()) {
    exactKeys(record, expectedKeys, `${label} ${index + 1}`);
    if (!Number.isSafeInteger(record.sequence) || record.sequence < 1 || record.sequence > 54
      || bySequence.has(record.sequence)) throw new Error(`${label} has invalid or duplicate sequence`);
    bySequence.set(record.sequence, record);
  }
  return bySequence;
}

/**
 * Join post-attempt evidence without adding identity fields to the oracle output.
 * attemptID, taskID, arm, and repetition are copied only from the validated manifest.
 */
export function bindExternalOracleEvaluations({
  manifest, oracleRecords, observerMetricRecords, executorEvidenceRecords,
}) {
  validatePhase3AttemptManifest(manifest);
  const oracles = recordsBySequence(oracleRecords, 'oracle records', ['sequence', 'result']);
  const observations = recordsBySequence(observerMetricRecords, 'observer metric records', ['sequence', 'metrics']);
  const executions = recordsBySequence(executorEvidenceRecords, 'executor evidence records', ['sequence', 'status', 'failure']);
  return [...manifest.attempts].sort((left, right) => left.sequence - right.sequence).map((attempt) => {
    const oracle = oracles.get(attempt.sequence).result;
    exactKeys(oracle, ['schema', 'taskId', 'arm', 'solved', 'failures'], `oracle result ${attempt.sequence}`);
    if (oracle.schema !== 'aishell.capability-oracle-result.v1'
      || oracle.taskId !== attempt.taskID || oracle.arm !== attempt.arm
      || typeof oracle.solved !== 'boolean' || !Array.isArray(oracle.failures)
      || oracle.failures.some((failure) => typeof failure !== 'string' || failure.length === 0)
      || new Set(oracle.failures).size !== oracle.failures.length
      || (oracle.solved && oracle.failures.length !== 0)
      || (!oracle.solved && oracle.failures.length === 0)) {
      throw new Error(`oracle result ${attempt.sequence} is incompatible with its manifest attempt`);
    }
    const observation = observations.get(attempt.sequence);
    validateMetricRecord(observation.metrics, `observer metric record ${attempt.sequence} metrics`);
    const execution = executions.get(attempt.sequence);
    if (!['completed', 'failed'].includes(execution.status)
      || (execution.status === 'completed' && execution.failure !== null)
      || (execution.status === 'failed' && (typeof execution.failure !== 'string' || execution.failure.length === 0))) {
      throw new Error(`executor evidence record ${attempt.sequence} is invalid`);
    }
    return {
      attemptID: attempt.attemptID,
      taskID: attempt.taskID,
      arm: attempt.arm,
      repetition: attempt.repetition,
      evaluationSource: 'external-oracle',
      harnessSucceeded: execution.status === 'completed',
      attemptSolved: oracle.solved,
      metrics: structuredClone(observation.metrics),
    };
  });
}

function validateExactSet(records, label) {
  if (!Array.isArray(records) || records.length !== 54) throw new Error(`${label} must contain exactly 54 records`);
  const expected = expectedTupleKeys();
  const seen = new Set();
  const attemptIDs = new Set();
  for (const [index, record] of records.entries()) {
    const item = `${label} ${index + 1}`;
    if (!TASKS.includes(record.taskID) || !ARMS.includes(record.arm) || !REPETITIONS.includes(record.repetition)) {
      throw new Error(`${item} has an unregistered task/arm/repetition tuple`);
    }
    const key = tupleKey(record);
    if (seen.has(key)) throw new Error(`${label} contains duplicate tuple ${record.taskID}/${record.arm}/${record.repetition}`);
    if (typeof record.attemptID !== 'string' || record.attemptID.length === 0 || attemptIDs.has(record.attemptID)) {
      throw new Error(`${item} has missing or duplicate attemptID`);
    }
    seen.add(key);
    attemptIDs.add(record.attemptID);
  }
  const missing = [...expected].filter((key) => !seen.has(key));
  if (missing.length !== 0) throw new Error(`${label} is missing preregistered tuples`);
}

function validateInputs(manifest, result, evaluations) {
  validatePhase3AttemptManifest(manifest);
  const runnerValidation = validatePhase3Result(result, manifest);
  if (!runnerValidation.valid) {
    throw new Error(`representative result failed runner validation: ${runnerValidation.reasons.join('; ')}`);
  }
  if (!plainObject(result) || result.schema !== 'aishell.phase3-representative-result.v1') {
    throw new Error('representative result schema is invalid');
  }
  if (result.status !== 'valid' || !Array.isArray(result.invalidReasons) || result.invalidReasons.length !== 0) {
    throw new Error('representative result is invalid');
  }
  validateExactSet(result.attempts, 'result attempts');
  const sequences = new Set();
  for (const [index, attempt] of result.attempts.entries()) {
    exactKeys(attempt, [
      'attemptID', 'sequence', 'taskID', 'arm', 'repetition', 'usage', 'providerTrace', 'agentResult',
      'providerUsageFormat', 'adapterTrace', 'agentExitCode', 'timedOut', 'wallMilliseconds',
    ], `attempt ${index + 1}`);
    if (!Number.isSafeInteger(attempt.sequence) || attempt.sequence < 1 || attempt.sequence > 54
      || sequences.has(attempt.sequence)) throw new Error(`attempt ${index + 1} sequence is invalid or duplicate`);
    sequences.add(attempt.sequence);
    if (attempt.usage === null || attempt.usage === undefined) throw new Error(`attempt ${index + 1} usage is missing`);
    validateUsage(attempt.usage, `attempt ${index + 1} usage`);
    if (!Number.isInteger(attempt.agentExitCode) || typeof attempt.timedOut !== 'boolean') {
      throw new Error(`attempt ${index + 1} execution outcome is invalid`);
    }
    nonnegativeInteger(attempt.wallMilliseconds, `attempt ${index + 1}.wallMilliseconds`);
  }

  validateExactSet(evaluations, 'external evaluations');
  const attempts = new Map(result.attempts.map((attempt) => [attempt.attemptID, attempt]));
  for (const [index, evaluation] of evaluations.entries()) {
    exactKeys(evaluation, [
      'attemptID', 'taskID', 'arm', 'repetition', 'evaluationSource', 'harnessSucceeded', 'attemptSolved', 'metrics',
    ], `external evaluation ${index + 1}`);
    if (evaluation.evaluationSource !== 'external-oracle') {
      throw new Error(`external evaluation ${index + 1} is not external-oracle output`);
    }
    if (evaluation.harnessSucceeded !== true) throw new Error(`external evaluation ${index + 1} reports harness failure`);
    if (typeof evaluation.attemptSolved !== 'boolean') throw new Error(`external evaluation ${index + 1} attemptSolved must be boolean`);
    validateMetricRecord(evaluation.metrics, `external evaluation ${index + 1} metrics`);
    const attempt = attempts.get(evaluation.attemptID);
    if (!attempt || tupleKey(attempt) !== tupleKey(evaluation)) {
      throw new Error(`external evaluation ${index + 1} does not bind its exact attempt`);
    }
    if (evaluation.attemptSolved && (attempt.agentExitCode !== 0 || attempt.timedOut)) {
      throw new Error(`external evaluation ${index + 1} solved outcome contradicts execution evidence`);
    }
  }
}

function quantile(values, probability) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const position = (sorted.length - 1) * probability;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + ((sorted[upper] - sorted[lower]) * (position - lower));
}

function aggregateBucket(records) {
  const attempts = records.length;
  const solvedAttempts = records.filter(({ evaluation }) => evaluation.attemptSolved).length;
  const totalModelTokens = records.reduce((sum, { attempt }) => sum + attempt.usage.totalModelTokens, 0);
  const firstUseful = records.flatMap(({ evaluation }) =>
    evaluation.metrics.firstUsefulResultMilliseconds === null ? [] : [evaluation.metrics.firstUsefulResultMilliseconds]);
  const totals = Object.fromEntries(COUNT_METRICS.map((key) => [
    key, records.reduce((sum, { evaluation }) => sum + evaluation.metrics[key], 0),
  ]));
  const adopted = records.filter(({ evaluation }) => evaluation.metrics.toolAdoption).length;
  return {
    attempts,
    solvedAttempts,
    successRate: solvedAttempts / attempts,
    totalModelTokens,
    tokensPerSolvedAttempt: solvedAttempts === 0
      ? { state: 'positive_infinity', value: null }
      : { state: 'finite', value: totalModelTokens / solvedAttempts },
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
    toolAdoption: { attempts: adopted, rate: adopted / attempts },
  };
}

function solvedTasks(perTaskArm, arm) {
  return perTaskArm.filter((entry) => entry.arm === arm && entry.taskSolved).map(({ taskID }) => taskID);
}

function difference(left, right) {
  const available = new Set(right);
  return left.filter((item) => !available.has(item));
}

export function aggregatePhase3Acceptance({
  manifest, result, oracleRecords, observerMetricRecords, executorEvidenceRecords,
}) {
  let evaluations;
  try {
    evaluations = bindExternalOracleEvaluations({
      manifest, oracleRecords, observerMetricRecords, executorEvidenceRecords,
    });
    validateInputs(manifest, result, evaluations);
  } catch (error) {
    return {
      schema: 'aishell.phase3-acceptance-report.v1',
      status: 'invalid',
      invalidReasons: [error.message],
      replacementPolicy: 'forbidden',
      overallArms: null,
      perTaskArms: null,
      correctnessGate: null,
    };
  }

  const evaluationsByID = new Map(evaluations.map((evaluation) => [evaluation.attemptID, evaluation]));
  const records = result.attempts.map((attempt) => ({ attempt, evaluation: evaluationsByID.get(attempt.attemptID) }));
  const perTaskArms = TASKS.flatMap((taskID) => ARMS.map((arm) => {
    const aggregate = aggregateBucket(records.filter(({ attempt }) => attempt.taskID === taskID && attempt.arm === arm));
    return { taskID, arm, taskSolved: aggregate.solvedAttempts === 3, ...aggregate };
  }));
  const overallArms = ARMS.map((arm) => {
    const aggregate = aggregateBucket(records.filter(({ attempt }) => attempt.arm === arm));
    const solvedTasks = perTaskArms.filter((entry) => entry.arm === arm && entry.taskSolved).length;
    return { arm, solvedTasks, taskSuccessRate: solvedTasks / TASKS.length, ...aggregate };
  });
  const native = solvedTasks(perTaskArms, 'native');
  const current = solvedTasks(perTaskArms, 'current-aishell-0.3.3');
  const candidate = solvedTasks(perTaskArms, 'candidate');
  const correctnessGate = {
    passed: difference(native, current).length === 0
      && difference(native, candidate).length === 0
      && difference(current, candidate).length === 0,
    nativeSolvedTasks: native,
    currentSolvedTasks: current,
    candidateSolvedTasks: candidate,
    currentRegressionsFromNative: difference(native, current),
    candidateRegressionsFromNative: difference(native, candidate),
    candidateRegressionsFromCurrent: difference(current, candidate),
  };
  return {
    schema: 'aishell.phase3-acceptance-report.v1',
    status: 'valid',
    invalidReasons: [],
    replacementPolicy: 'forbidden',
    overallArms,
    perTaskArms,
    correctnessGate,
  };
}

async function main() {
  const [manifestPath, resultPath, oraclePath, metricsPath, executorPath] = process.argv.slice(2);
  if (!manifestPath || !resultPath || !oraclePath || !metricsPath || !executorPath) {
    throw new Error('usage: phase3-acceptance-aggregate.mjs <manifest.json> <representative-result.json> <oracle-records.json> <observer-metrics.json> <executor-evidence.json>');
  }
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const result = JSON.parse(await readFile(resultPath, 'utf8'));
  const oracleRecords = JSON.parse(await readFile(oraclePath, 'utf8'));
  const observerMetricRecords = JSON.parse(await readFile(metricsPath, 'utf8'));
  const executorEvidenceRecords = JSON.parse(await readFile(executorPath, 'utf8'));
  const report = aggregatePhase3Acceptance({
    manifest, result, oracleRecords, observerMetricRecords, executorEvidenceRecords,
  });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (report.status !== 'valid' || !report.correctnessGate.passed) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
