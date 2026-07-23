#!/usr/bin/env node

import assert from 'node:assert/strict';

import {
  buildRepresentativeAttemptManifest,
  runRepresentativeAttempts,
  validateRepresentativeAttemptManifest,
} from './representative-production-runner.mjs';

const digest = (character) => character.repeat(64);
const configuration = {
  schema: 'aishell.representative-run-configuration.v1',
  provider: 'codex',
  modelSnapshot: 'model-main',
  reasoningEffort: 'low',
  sandbox: { approvalPolicy: 'on-request', filesystem: 'workspace-write', network: false },
  commonHostCatalogDigest: digest('a'),
  approvalReviewer: { mode: 'auto_review', modelSnapshots: ['model-reviewer'] },
  armBindings: {
    native: { binding: 'native', aishellBinaryDigest: null, aishellToolCatalogDigest: null },
    'current-aishell-0.3.3': {
      binding: 'current', aishellBinaryDigest: digest('b'), aishellToolCatalogDigest: digest('c'),
    },
    candidate: { binding: 'candidate', aishellBinaryDigest: digest('d'), aishellToolCatalogDigest: digest('e') },
  },
};

const manifest = await buildRepresentativeAttemptManifest(configuration);
assert.equal(validateRepresentativeAttemptManifest(manifest), manifest);
assert.equal(manifest.tasks.length, 32);
assert.equal(manifest.attempts.length, 288);
assert.deepEqual(manifest.attempts.slice(0, 9).map(({ repetition }) => repetition), [1, 1, 1, 2, 2, 2, 3, 3, 3]);
for (let index = 0; index < manifest.attempts.length; index += 3) {
  assert.equal(new Set(manifest.attempts.slice(index, index + 3).map(({ promptSHA256 }) => promptSHA256)).size, 1);
  assert.equal(new Set(manifest.attempts.slice(index, index + 3).map(({ materializedFixtureSHA256 }) => materializedFixtureSHA256)).size, 1);
}

assert.throws(() => validateRepresentativeAttemptManifest({ ...manifest, attempts: manifest.attempts.slice(1) }), /288 attempts/u);

const calls = [];
await assert.rejects(() => runRepresentativeAttempts({
  manifest,
  priorRecords: [{ attemptID: 'not-the-prefix' }],
  executeAttempt: async () => { throw new Error('must not execute'); },
}), /frozen prefix/u);

const completedPrefix = manifest.attempts.slice(0, 48).map(({ attemptID }) => ({ attemptID }));
const resumedCalls = [];
await assert.rejects(() => runRepresentativeAttempts({
  manifest,
  priorRecords: completedPrefix,
  executeAttempt: async ({ attempt }) => {
    resumedCalls.push(attempt.attemptID);
    throw new Error('resume sentinel stop');
  },
}), /resume sentinel stop/u);
assert.deepEqual(resumedCalls, [manifest.attempts[48].attemptID]);

await assert.rejects(() => runRepresentativeAttempts({
  manifest,
  executeAttempt: async ({ attempt }) => {
    calls.push(attempt.attemptID);
    throw new Error('sentinel stop');
  },
}), /sentinel stop/u);
assert.deepEqual(calls, [manifest.attempts[0].attemptID]);

process.stdout.write('representative production runner tests passed\n');
