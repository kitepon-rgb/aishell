#!/usr/bin/env node

import assert from 'node:assert/strict';

import {
  mergeCandidateRebindPrefix,
  validateCandidateRebindManifests,
} from './rebind-representative-candidate.mjs';
import { buildRepresentativeAttemptManifest } from './representative-production-runner.mjs';

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
    candidate: { binding: 'candidate-v1', aishellBinaryDigest: digest('d'), aishellToolCatalogDigest: digest('e') },
  },
};
const sourceManifest = await buildRepresentativeAttemptManifest(configuration);
const targetManifest = await buildRepresentativeAttemptManifest({
  ...configuration,
  armBindings: {
    ...configuration.armBindings,
    candidate: { binding: 'candidate-v2', aishellBinaryDigest: digest('f'), aishellToolCatalogDigest: digest('1') },
  },
});
assert.equal(validateCandidateRebindManifests(sourceManifest, targetManifest), targetManifest);
const invalid = structuredClone(targetManifest);
invalid.isolation.modelSnapshot = 'different-model';
assert.throws(() => validateCandidateRebindManifests(sourceManifest, invalid), /beyond the candidate binding/u);

const sourceRecords = sourceManifest.attempts.slice(0, 6).map((attempt) => ({
  attemptID: attempt.attemptID,
  sequence: attempt.sequence,
  timedOut: false,
  usage: { totalModelTokens: 1 },
  marker: 'source',
}));
const recoveredRecords = targetManifest.attempts.slice(0, 6)
  .filter(({ arm }) => arm === 'candidate').map((attempt) => ({
    attemptID: attempt.attemptID,
    sequence: attempt.sequence,
    timedOut: false,
    usage: { totalModelTokens: 2 },
    marker: 'rebound',
  }));
const merged = mergeCandidateRebindPrefix({ sourceManifest, sourceRecords, recoveredRecords });
assert.deepEqual(
  merged.map(({ marker }) => marker),
  sourceManifest.attempts.slice(0, 6).map(({ arm }) => arm === 'candidate' ? 'rebound' : 'source'),
);
assert.throws(() => mergeCandidateRebindPrefix({
  sourceManifest,
  sourceRecords,
  recoveredRecords: recoveredRecords.slice(1),
}), /recovery is incomplete/u);

process.stdout.write('representative candidate rebind tests passed\n');
