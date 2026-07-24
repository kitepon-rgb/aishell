#!/usr/bin/env node

import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import {
  captureTrustedSetup,
  collectAttemptEvidence,
} from '../../benchmarks/phase3-local-callbacks.mjs';
import { observeAttempt } from '../../benchmarks/observe-capability-attempt.mjs';
import { evaluateAttempt } from '../../benchmarks/evaluate-capability-oracle.mjs';

const projectRoot = path.resolve(import.meta.dirname, '../..');
const manifestPath = path.join(import.meta.dirname, 'ace035-phase3-attempt-manifest.json');
const outputDirectory = path.join(projectRoot, 'benchmarks/results/phase3-production-20260723-restart-v10');
const reportPath = path.join(import.meta.dirname, 'ace035-restart-v10-candidate-reprojection.json');
const replayRoot = await mkdtemp(path.join(tmpdir(), 'aishell-phase3-reprojection-'));

async function json(file) {
  return JSON.parse(await readFile(file, 'utf8'));
}

async function jsonLines(file) {
  return (await readFile(file, 'utf8')).split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

const manifest = await json(manifestPath);
const attempts = [];
for (const attempt of manifest.attempts.filter(({ arm }) => arm === 'candidate')) {
  const runDirectory = path.join(outputDirectory, attempt.attemptID);
  const workspace = path.join(runDirectory, 'workspace');
  const stateDirectory = path.join(runDirectory, 'runtime-state');
  const trustedProductionSetup = await captureTrustedSetup({
    attempt,
    armBinding: manifest.armBindings[attempt.arm],
    workspace,
    stateDirectory,
  });
  const processEvidence = await json(path.join(runDirectory, 'observer-process.json'));
  const evidence = await collectAttemptEvidence({
    attempt,
    workspace,
    stateDirectory,
    runDirectory,
    mcpWireDirectory: path.join(runDirectory, 'mcp-wire'),
    baselineManifest: await json(path.join(runDirectory, 'baseline-manifest.json')),
    preAttemptManifest: await json(path.join(runDirectory, 'pre-attempt-manifest.json')),
    benchmarkSetupEvidence: await json(path.join(runDirectory, 'setup-evidence.json')),
    trustedProductionSetup,
    agentEvents: await jsonLines(path.join(runDirectory, 'provider-events.jsonl')),
    finalAgent: await json(path.join(runDirectory, 'agent-result.json')),
    execution: {
      exitCode: processEvidence.agentExitCode,
      timedOut: processEvidence.agentTimedOut,
    },
  });
  const evidenceDirectory = path.join(replayRoot, attempt.attemptID);
  await mkdir(evidenceDirectory);
  const evidenceFiles = {};
  for (const [name, value] of Object.entries({
    result: evidence.result,
    process: evidence.process,
    telemetry: evidence.telemetry,
    trace: evidence.trace,
    toolTrace: evidence.toolTrace,
  })) {
    evidenceFiles[name] = path.join(evidenceDirectory, `${name}.json`);
    await writeFile(evidenceFiles[name], `${JSON.stringify(value)}\n`, { flag: 'wx' });
  }
  const observation = await observeAttempt({
    taskId: attempt.taskID,
    armId: attempt.arm,
    workspace,
    baselineFile: path.join(runDirectory, 'baseline-manifest.json'),
    preAttemptFile: path.join(runDirectory, 'pre-attempt-manifest.json'),
    setupEvidenceFile: path.join(runDirectory, 'setup-evidence.json'),
    requestContractFile: path.join(runDirectory, 'observer-request-contract.json'),
    resultFile: evidenceFiles.result,
    processFile: evidenceFiles.process,
    artifactStore: evidence.artifactStore,
    telemetryFile: evidenceFiles.telemetry,
    traceFile: evidenceFiles.trace,
    toolTraceFile: evidenceFiles.toolTrace,
    agentReportFile: path.join(runDirectory, 'agent-result.json'),
  });
  const oracle = await evaluateAttempt({
    taskId: attempt.taskID,
    armId: attempt.arm,
    actual: observation,
  });
  attempts.push({
    attemptID: attempt.attemptID,
    taskID: attempt.taskID,
    repetition: attempt.repetition,
    result: evidence.result,
    telemetry: evidence.telemetry,
    metrics: evidence.metrics,
    acceptedInvocations: observation.capabilityEvidence.acceptedInvocations,
    solved: oracle.solved,
    failures: oracle.failures,
    adapterTraceSHA256: evidence.adapterTraceBytes === null
      ? null
      : (await import('node:crypto')).createHash('sha256').update(evidence.adapterTraceBytes).digest('hex'),
  });
}

const report = {
  schema: 'aishell.phase3-candidate-reprojection.v1',
  sourceRun: outputDirectory,
  attempts,
};
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
process.stdout.write(`${JSON.stringify({ reportPath, attempts: attempts.length })}\n`);
