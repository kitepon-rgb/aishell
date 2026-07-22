#!/usr/bin/env node

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { canonicalJSONBytes } from './production-v2-benchmark-adapter.mjs';
import { materializeCapabilityRequestV2 } from './materialize-capability-request-v2.mjs';

const root = new URL('./', import.meta.url);
const readJSON = async (name) => JSON.parse(await readFile(new URL(name, root), 'utf8'));
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

const suite = await readJSON('capability-benchmark-suite.v2.json');
const fixtures = await readJSON('capability-fixtures.v2.json');
const oracles = await readJSON('capability-oracles.v2.json');
const aggregation = await readJSON('capability-aggregation.v2.json');
const manifest = await readJSON('capability-benchmark-freeze.v2.json');

assert.equal(suite.schema, 'aishell.capability-benchmark-suite.v2');
assert.deepEqual(suite.tasks.map(({ id }) => id), [
  'batch-context-multi-query',
  'async-process-first-useful-result',
  'async-process-cancel',
  'workspace-wait-external-edit',
  'workspace-wait-event-gap',
]);
assert.equal(fixtures.schema, 'aishell.capability-fixtures.v2');
assert.equal(oracles.schema, 'aishell.capability-oracles.v2');
assert.equal(aggregation.schema, 'aishell.capability-aggregation.v2');

const specimen = manifest.specimen;
assert.equal(specimen.fixtureRoot, '/Users/kite/Developer/aishell/benchmarks/fixtures/capability-v2');
assert.match(specimen.setupCursor, /^ws2:[^\s]+$/u);

const search = materializeCapabilityRequestV2({
  taskId: 'batch-context-multi-query', fixtureRoot: specimen.fixtureRoot, setupCursor: specimen.setupCursor,
});
assert.deepEqual(search.request.queries.map(({ id }) => id), [
  'fixed-needle', 'regex-export', 'glob-src', 'glob-test',
]);
assert.equal(search.request.changed_since_cursor, specimen.setupCursor);
assert.deepEqual(search.bytes, canonicalJSONBytes(search.request));
assert.equal(digest(search.bytes), manifest.specimen.requests['batch-context-multi-query'].sha256);
assert.deepEqual(search.bytes, Buffer.from(manifest.specimen.requests['batch-context-multi-query'].canonicalBase64, 'base64'));

for (const taskId of suite.tasks.map(({ id }) => id).filter((id) => id !== 'batch-context-multi-query')) {
  const materialized = materializeCapabilityRequestV2({
    taskId, fixtureRoot: specimen.fixtureRoot, setupCursor: specimen.setupCursor,
  });
  assert.deepEqual(materialized.bytes, canonicalJSONBytes(materialized.request));
  assert.equal(digest(materialized.bytes), manifest.specimen.requests[taskId].sha256);
  assert.deepEqual(materialized.bytes, Buffer.from(manifest.specimen.requests[taskId].canonicalBase64, 'base64'));
}

for (const [name, expected] of Object.entries(manifest.artifacts)) {
  const bytes = await readFile(new URL(name, root));
  assert.equal(bytes.length, expected.bytes, `${name} byte length`);
  assert.equal(digest(bytes), expected.sha256, `${name} digest`);
}

for (const [name, expected] of Object.entries(manifest.v1Locks)) {
  const bytes = await readFile(new URL(name, root));
  assert.equal(bytes.length, expected.bytes, `${name} v1 byte length`);
  assert.equal(digest(bytes), expected.sha256, `${name} v1 digest`);
}

console.log('benchmark v2 freeze: ok');
