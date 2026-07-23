#!/usr/bin/env node

import assert from 'node:assert/strict';

import {
  mergeRecoveredRecords,
  selectTimeoutRecoveryRecords,
} from './recover-representative-timeouts.mjs';

const complete = (sequence) => ({
  sequence, attemptID: `attempt-${sequence}`, timedOut: false,
  usage: { source: 'provider', totalModelTokens: sequence },
});
const timeout = (sequence) => ({ sequence, attemptID: `attempt-${sequence}`, timedOut: true, usage: null });
const source = [complete(1), timeout(2), complete(3), timeout(4)];
assert.deepEqual(selectTimeoutRecoveryRecords(source).map(({ sequence }) => sequence), [2, 4]);
const recovered = [complete(2), complete(4)];
assert.deepEqual(mergeRecoveredRecords(source, recovered), [complete(1), complete(2), complete(3), complete(4)]);
await assert.rejects(async () => mergeRecoveredRecords(source, [complete(2)]), /incomplete/u);
await assert.rejects(async () => selectTimeoutRecoveryRecords([complete(1), { ...timeout(2), usage: {} }]), /complete usage/u);
process.stdout.write('{"schema":"aishell.representative-timeout-recovery-self-test.v1","status":"valid"}\n');
