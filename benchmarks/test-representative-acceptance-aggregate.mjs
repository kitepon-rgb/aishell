#!/usr/bin/env node

import assert from 'node:assert/strict';

import { aggregateValidatedRepresentativeRecords } from './representative-acceptance-aggregate.mjs';

const telemetry = {
  silentFallbacks: 0, silentTruncations: 0, falseFresh: 0, silentFullScans: 0,
  partialWrites: 0, silentTextFallbacks: 0, silentLexicalFallbacks: 0,
};
const metric = {
  firstUsefulResultMilliseconds: null, toolCalls: 1, modelTurns: 1, retries: 0,
  artifactRereads: 0, filesystemEntriesRescanned: 0, bytesReread: 0,
  processReexecutions: 0, cacheHits: 0, changeJournalHits: 0, toolAdoption: true,
};
const records = [];
for (const taskID of ['task-a', 'task-b']) {
  for (const arm of ['native', 'current-aishell-0.3.3', 'candidate']) {
    for (let repetition = 1; repetition <= 3; repetition += 1) {
      const candidate = arm === 'candidate';
      records.push({
        attempt: {
          taskID, arm, repetition, wallMilliseconds: candidate ? 90 : 100,
          usage: { totalModelTokens: candidate ? 60 : 100 },
        },
        oracle: { solved: true }, metrics: metric, telemetry: candidate ? telemetry : null,
      });
    }
  }
}
const report = aggregateValidatedRepresentativeRecords(records);
assert.equal(report.overallArms.find(({ arm }) => arm === 'native').tokensPerSolvedTask, 300);
assert.equal(report.overallArms.find(({ arm }) => arm === 'candidate').tokensPerSolvedTask, 180);
assert.equal(report.gate.tokenReduction, 0.4);
assert.equal(report.gate.passed, true);

const failed = structuredClone(records);
failed.find(({ attempt }) => attempt.arm === 'candidate').telemetry.silentFallbacks = 1;
assert.equal(aggregateValidatedRepresentativeRecords(failed).gate.passed, false);

const regression = structuredClone(records);
for (const record of regression.filter(({ attempt }) => attempt.arm === 'candidate' && attempt.taskID === 'task-a')) {
  record.oracle.solved = false;
}
const regressionReport = aggregateValidatedRepresentativeRecords(regression);
assert.deepEqual(regressionReport.correctness.candidateRegressionsFromNative, ['task-a']);
assert.equal(regressionReport.gate.passed, false);

process.stdout.write('representative acceptance aggregate: ok\n');
