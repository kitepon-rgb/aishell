#!/usr/bin/env node

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BenchmarkAdapterError,
  adaptFrozenCapabilityRequest,
  buildBenchmarkTrace,
  canonicalDigest,
  canonicalJSONBytes,
  frozenRunCheckBindingDigest,
  projectProductionV2Result,
  sha256Hex,
} from './production-v2-benchmark-adapter.mjs';

const digest = (character) => character.repeat(64);
const candidateID = digest('a');
const evidenceID = digest('b');

function artifactFor(items) {
  const bytes = Buffer.concat(items.map((item) => Buffer.concat([canonicalJSONBytes(item), Buffer.from('\n')])));
  return { bytes, descriptor: { handle: 'art_fixture', kind: 'change-impact-jsonl', sizeBytes: bytes.length, lineCount: items.length,
    sha256: sha256Hex(bytes), createdAt: '2026-07-22T00:00:00Z', expiresAt: '2026-07-23T00:00:00Z', producer: 'change_impact' } };
}

function analyzePage(items, overrides = {}) {
  const artifact = artifactFor(items);
  return {
    artifact,
    pages: [{ result: {
      schemaVersion: 'aishell.change-impact.v2', operation: 'analyze', coverage: 'partial', freshness: {}, counts: {},
      items, returnedBytes: artifact.bytes.length, omittedBytes: 0, hasMore: false, continuation: null,
      artifact: artifact.descriptor, ...overrides,
    } }],
  };
}

function recommendPage(items, overrides = {}) {
  const artifact = artifactFor(items);
  return {
    artifact,
    pages: [{ result: {
      schema: 'aishell.change-impact.v2', operation: 'recommend', executionPolicy: 'explicit_run_check_only',
      focusedSetID: 'set_fixture', focusedSetDigest: digest('c'), expiresAt: '2026-07-23T00:00:00Z', freshness: {},
      coverage: 'partial', candidateCount: 1, stepCount: 1, limitationCount: 0, items,
      byteBudget: 1_048_576, hasMore: false, continuation: null, artifact: artifact.descriptor, ...overrides,
    } }],
  };
}

function assertCode(code, fn) {
  assert.throws(fn, (error) => error instanceof BenchmarkAdapterError && error.code === code);
}

test('canonical sorted-key bytes and SHA-256 are stable', () => {
  const bytes = canonicalJSONBytes({ z: 1, a: { d: 2, c: 3 } });
  assert.equal(bytes.toString(), '{"a":{"c":3,"d":2},"z":1}');
  assert.equal(canonicalDigest({ z: 1, a: { d: 2, c: 3 } }), sha256Hex(bytes));
});

test('change_impact joins exact path SHA/provider evidence and emits a closed v2 request', () => {
  const request = { action: 'analyze', changed_paths: ['src/a.mjs'], providers: ['static-import'] };
  const adapted = adaptFrozenCapabilityRequest({ tool: 'change_impact', request, trustedSetupEvidence: {
    schema: 'aishell.production-v2-benchmark-setup.v1', tool: 'change_impact', root: '/benchmark-fixture', rootIdentity: 'root:fixture',
    workspaceCursor: 'ws2:fixture:1',
    pathBindings: [{ path: 'src/a.mjs', contentSHA256: digest('d') }], providerIDs: ['static-import'],
  } });
  assert.deepEqual(Object.keys(adapted).sort(), ['byte_budget', 'changed_paths', 'operation', 'required_providers', 'root', 'workspace_cursor']);
  assert.deepEqual(adapted, { operation: 'analyze', root: '/benchmark-fixture', workspace_cursor: 'ws2:fixture:1',
    changed_paths: [{ path: 'src/a.mjs', content_sha256: digest('d') }], required_providers: ['static-import'], byte_budget: 1_048_576 });
  assertCode('BENCHMARK_SETUP_INVALID', () => adaptFrozenCapabilityRequest({ tool: 'change_impact',
    request, trustedSetupEvidence: { schema: 'aishell.production-v2-benchmark-setup.v1', tool: 'change_impact',
      root: '/benchmark-fixture', rootIdentity: 'root:fixture', workspaceCursor: 'ws2:fixture:1',
      pathBindings: [{ path: 'src/a.mjs', contentSHA256: digest('D') }], providerIDs: ['static-import'] } }));
  assertCode('BENCHMARK_SETUP_INVALID', () => adaptFrozenCapabilityRequest({ tool: 'change_impact',
    request: { ...request, unexpected: true }, trustedSetupEvidence: {} }));
});

test('recommend requires exact project/profile setup and preserves only production v2 fields', () => {
  const adapted = adaptFrozenCapabilityRequest({ tool: 'change_impact',
    request: { action: 'recommend', changed_paths: ['src/a.mjs'], providers: ['static-import'] },
    trustedSetupEvidence: { schema: 'aishell.production-v2-benchmark-setup.v1', tool: 'change_impact',
      root: '/benchmark-fixture', rootIdentity: 'root:fixture', workspaceCursor: 'ws2:fixture:1',
      pathBindings: [{ path: 'src/a.mjs', expectedAbsent: true }],
      providerIDs: ['static-import'], projectID: 'project', profileDigest: digest('e') } });
  assert.deepEqual(Object.keys(adapted).sort(), ['byte_budget', 'changed_paths', 'operation', 'profile_digest', 'project_id', 'required_providers', 'root', 'workspace_cursor']);
  assert.deepEqual(adapted.changed_paths, [{ path: 'src/a.mjs', expected_absent: true }]);
});

test('change_impact rejects missing, relative, and non-canonical trusted roots', () => {
  const request = { action: 'analyze', changed_paths: ['src/a.mjs'], providers: ['static-import'] };
  const setup = { schema: 'aishell.production-v2-benchmark-setup.v1', tool: 'change_impact', rootIdentity: 'root:fixture',
    workspaceCursor: 'ws2:fixture:1', pathBindings: [{ path: 'src/a.mjs', contentSHA256: digest('d') }],
    providerIDs: ['static-import'] };
  assertCode('BENCHMARK_SETUP_INVALID', () => adaptFrozenCapabilityRequest({ tool: 'change_impact', request,
    trustedSetupEvidence: setup }));
  for (const root of ['benchmark-fixture', '/benchmark-fixture/', '/benchmark/../benchmark-fixture', '/benchmark//fixture']) {
    assertCode('BENCHMARK_SETUP_INVALID', () => adaptFrozenCapabilityRequest({ tool: 'change_impact', request,
      trustedSetupEvidence: { ...setup, root } }));
  }
});

test('run_check can only become an exact trusted profile_check, never direct', () => {
  const request = { action: 'execute', executable: 'node', arguments: ['check.mjs'], freshness_inputs: ['check.mjs', 'src/value.mjs'] };
  const adapted = adaptFrozenCapabilityRequest({ tool: 'run_check', request, trustedSetupEvidence: {
    schema: 'aishell.production-v2-benchmark-setup.v1', tool: 'run_check', cache: 'prefer', selection: { binding: 'prepare' },
    executionPolicy: { timeoutMs: 120_000, retentionSeconds: 86_400 },
    profileCheck: { projectID: 'project', profileDigest: digest('f'), checkID: 'test', frozenBindingDigest: frozenRunCheckBindingDigest(request) },
  } });
  assert.equal(adapted.invocation.mode, 'profile_check');
  assert.equal(JSON.stringify(adapted).includes('executable'), false);
  assert.deepEqual(adapted.selection, { binding: 'prepare' });
  assertCode('BENCHMARK_SETUP_INVALID', () => adaptFrozenCapabilityRequest({ tool: 'run_check', request,
    trustedSetupEvidence: { schema: 'aishell.production-v2-benchmark-setup.v1', tool: 'run_check', cache: 'prefer',
      selection: { binding: 'prepare' }, executionPolicy: { timeoutMs: 120_000, retentionSeconds: 86_400 },
      profileCheck: { projectID: 'project', profileDigest: digest('f'), checkID: 'test', frozenBindingDigest: digest('0') } } }));
});

test('analyze projection has exact v1 keys and joins candidate evidence', () => {
  const items = [
    { kind: 'candidate', itemID: 'candidate', candidateID, category: 'references', subject: { kind: 'path', path: 'src/b.mjs' } },
    { kind: 'evidence', itemID: 'evidence', evidenceID, providerID: 'static-import', inputIdentity: 'src/a.mjs',
      subject: { kind: 'path', path: 'src/b.mjs' }, relation: 'lexical_reference', locator: {}, evidenceStrength: 'lexical_match', summary: 'import' },
    { kind: 'candidate_evidence', itemID: 'edge', candidateID, evidenceID },
    { kind: 'coverage_gap', itemID: 'gap', coverageGap: { reasonCode: 'dynamic_import' } },
  ];
  const { pages, artifact } = analyzePage(items);
  const projected = projectProductionV2Result({ tool: 'change_impact',
    frozenRequest: { action: 'analyze', changed_paths: ['src/a.mjs'], providers: ['static-import'] },
    rawV2Pages: pages, completeArtifactBytes: artifact.bytes });
  assert.deepEqual(Object.keys(projected).sort(), ['impactedPaths', 'provenance', 'schemaVersion', 'silentCompletenessClaims', 'unknowns']);
  assert.deepEqual(projected, { schemaVersion: 'aishell.change-impact.v1', impactedPaths: ['src/b.mjs'],
    provenance: 'static-import', unknowns: 1, silentCompletenessClaims: 0 });
});

test('analyze projection accepts the production test path subject for related_tests', () => {
  const testCandidateID = digest('3');
  const testEvidenceID = digest('4');
  const items = [
    { kind: 'candidate', itemID: 'test-candidate', candidateID: testCandidateID, category: 'related_tests',
      subject: { kind: 'test', path: 'test/b.test.mjs' } },
    { kind: 'evidence', itemID: 'test-evidence', evidenceID: testEvidenceID, providerID: 'static-import',
      inputIdentity: 'src/a.mjs', subject: { kind: 'test', path: 'test/b.test.mjs' }, relation: 'contains_test',
      locator: {}, evidenceStrength: 'declared_edge', summary: 'related test' },
    { kind: 'candidate_evidence', itemID: 'test-edge', candidateID: testCandidateID, evidenceID: testEvidenceID },
  ];
  const { pages, artifact } = analyzePage(items);
  const projected = projectProductionV2Result({ tool: 'change_impact',
    frozenRequest: { action: 'analyze', changed_paths: ['src/a.mjs'], providers: ['static-import'] },
    rawV2Pages: pages, completeArtifactBytes: artifact.bytes });
  assert.deepEqual(projected.impactedPaths, ['test/b.test.mjs']);
  assert.equal(projected.provenance, 'static-import');
});

test('unknown candidate edge and artifact mismatch fail closed', () => {
  const edge = { kind: 'candidate_evidence', itemID: 'edge', candidateID, evidenceID };
  const unknown = analyzePage([edge]);
  assertCode('BENCHMARK_PROJECTION_INVALID', () => projectProductionV2Result({ tool: 'change_impact',
    frozenRequest: { action: 'analyze', changed_paths: ['src/a.mjs'], providers: ['static-import'] },
    rawV2Pages: unknown.pages, completeArtifactBytes: unknown.artifact.bytes }));

  const valid = analyzePage([]);
  valid.pages[0].result.artifact.sha256 = digest('9');
  assertCode('BENCHMARK_PROJECTION_INVALID', () => projectProductionV2Result({ tool: 'change_impact',
    frozenRequest: { action: 'analyze', changed_paths: ['src/a.mjs'], providers: ['static-import'] },
    rawV2Pages: valid.pages, completeArtifactBytes: valid.artifact.bytes }));
});

test('dynamic coverage gap is counted without manufacturing a candidate', () => {
  const fixture = analyzePage([{ kind: 'coverage_gap', itemID: 'gap', coverageGap: { reasonCode: 'dynamic_import' } }], { coverage: 'complete' });
  const projected = projectProductionV2Result({ tool: 'change_impact',
    frozenRequest: { action: 'analyze', changed_paths: ['src/dynamic.mjs'], providers: ['static-import'] },
    rawV2Pages: fixture.pages, completeArtifactBytes: fixture.artifact.bytes });
  assert.deepEqual(projected.impactedPaths, []);
  assert.equal(projected.unknowns, 1);
  assert.equal(projected.silentCompletenessClaims, 1);
});

test('recommend projection requires policy and only projects test_path selectors', () => {
  const item = { kind: 'focused_candidate', itemID: 'focused', focusedCheckID: 'focused-1', profileCheckID: 'test',
    profileDigest: digest('c'), selector: { kind: 'test_path', path: 'test/b.test.mjs' } };
  const fixture = recommendPage([item]);
  const projected = projectProductionV2Result({ tool: 'change_impact',
    frozenRequest: { action: 'recommend', changed_paths: ['src/a.mjs'], providers: ['static-import'] },
    rawV2Pages: fixture.pages, completeArtifactBytes: fixture.artifact.bytes });
  assert.deepEqual(Object.keys(projected).sort(), ['executionRequiresOptIn', 'recommendedChecks', 'schemaVersion']);
  assert.deepEqual(projected.recommendedChecks, ['test/b.test.mjs']);
  const invalid = recommendPage([item], { executionPolicy: undefined });
  assertCode('BENCHMARK_PROJECTION_INVALID', () => projectProductionV2Result({ tool: 'change_impact',
    frozenRequest: { action: 'recommend', changed_paths: ['src/a.mjs'], providers: ['static-import'] },
    rawV2Pages: invalid.pages, completeArtifactBytes: invalid.artifact.bytes }));
});

test('run_check projection extracts the frozen telemetry without an oracle', () => {
  const productionResult = { schemaVersion: 'aishell.run-check.v2', planDigest: digest('1'), selectionDigest: digest('2'),
    requestedCheckIDs: ['test'], plannedCheckIDs: ['test'], cacheState: 'hit', processesStarted: 0, publications: 0,
    steps: [], lookupEvidence: [{ stepID: 'test', status: 'hit', ineligibilityReason: null }] };
  assert.deepEqual(projectProductionV2Result({ tool: 'run_check', frozenRequest: {}, productionResult }),
    { secondExecutionCount: 0, cacheHit: true, falseFresh: 0 });
});

test('trace preserves stage order, exact bytes, token chain and digests', () => {
  const fixture = analyzePage([]);
  const v1 = Buffer.from('{"action":"analyze"}');
  const v2 = Buffer.from('{"operation":"analyze"}');
  const projected = Buffer.from('{"schemaVersion":"aishell.change-impact.v1"}');
  const compactResultBytes = Buffer.from(JSON.stringify(fixture.pages[0].result));
  const reorderedResult = Object.fromEntries(Object.entries(fixture.pages[0].result).reverse());
  const reorderedResultBytes = Buffer.from(JSON.stringify(reorderedResult, null, 2));
  const trace = buildBenchmarkTrace({ v1RequestBytes: v1, trustedSetupEvidence: { exact: true }, v2RequestBytes: v2,
    rawV2Pages: [{ ...fixture.pages[0], resultBytes: compactResultBytes }],
    completeArtifactBytes: fixture.artifact.bytes, projectedV1Bytes: projected });
  const reorderedTrace = buildBenchmarkTrace({ v1RequestBytes: v1, trustedSetupEvidence: { exact: true }, v2RequestBytes: v2,
    rawV2Pages: [{ ...fixture.pages[0], resultBytes: reorderedResultBytes }],
    completeArtifactBytes: fixture.artifact.bytes, projectedV1Bytes: projected });
  assert.deepEqual(trace.stages.map(({ kind }) => kind), ['v1_request', 'trusted_setup', 'v2_request', 'raw_v2_pages', 'projected_v1_result']);
  assert.equal(trace.stages[0].bytes.equals(v1), true);
  assert.equal(trace.stages[0].sha256, sha256Hex(v1));
  assert.equal(trace.stages[3].completeArtifactSHA256, fixture.artifact.descriptor.sha256);
  assert.equal(trace.stages[3].pages[0].resultBytes.equals(compactResultBytes), true);
  assert.equal(reorderedTrace.stages[3].pages[0].resultBytes.equals(reorderedResultBytes), true);
  assert.notEqual(trace.stages[3].pages[0].sha256, reorderedTrace.stages[3].pages[0].sha256);
  assert.equal(trace.stages[4].bytes.equals(projected), true);
});

test('trace rejects missing, invalid, or object-mismatched exact result bytes', () => {
  const fixture = analyzePage([]);
  const shared = { v1RequestBytes: Buffer.from('{}'), trustedSetupEvidence: {}, v2RequestBytes: Buffer.from('{}'),
    completeArtifactBytes: fixture.artifact.bytes, projectedV1Bytes: Buffer.from('{}') };
  assertCode('BENCHMARK_PROJECTION_INVALID', () => buildBenchmarkTrace({ ...shared, rawV2Pages: fixture.pages }));
  assertCode('BENCHMARK_PROJECTION_INVALID', () => buildBenchmarkTrace({ ...shared,
    rawV2Pages: [{ ...fixture.pages[0], resultBytes: Buffer.from('{') }] }));
  assertCode('BENCHMARK_PROJECTION_INVALID', () => buildBenchmarkTrace({ ...shared,
    rawV2Pages: [{ ...fixture.pages[0], resultBytes: Buffer.from('{"different":true}') }] }));
});
