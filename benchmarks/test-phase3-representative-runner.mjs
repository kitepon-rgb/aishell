#!/usr/bin/env node

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  assemblePhase3Result,
  assertNoOracleValueSentinels,
  buildPhase3AttemptManifest,
  candidateAdapterTraceBytes,
  exactByteBinding,
  extractProviderUsageFromTrace,
  normalizeProviderUsage,
  oracleFreeFixtureMaterial,
  prepareCandidateRequests,
  recordCandidateProjection,
  runPhase3Attempts,
  validatePhase3Result,
} from './phase3-representative-runner.mjs';
import {
  adaptFrozenCapabilityRequest, buildBenchmarkTrace, canonicalJSONBytes, frozenRunCheckBindingDigest,
  projectProductionV2Result, sha256Hex,
} from './production-v2-benchmark-adapter.mjs';

const digest = (value) => createHash('sha256').update(value).digest('hex');
const configuration = {
  schema: 'aishell.phase3-run-configuration.v1',
  provider: 'fixture-provider',
  modelSnapshot: 'fixture-model-snapshot-2026-07-22',
  reasoningEffort: 'medium',
  sandbox: { approvalPolicy: 'never', filesystem: 'isolated-disposable-workspace', network: false },
  commonHostCatalogDigest: digest('same-common-host-catalog'),
  armBindings: {
    native: { binding: 'frozen native host surface', aishellBinaryDigest: null, aishellToolCatalogDigest: null },
    'current-aishell-0.3.3': {
      binding: 'frozen AIShell 0.3.3 package',
      aishellBinaryDigest: digest('current-binary'),
      aishellToolCatalogDigest: digest('current-catalog'),
    },
    candidate: {
      binding: 'candidate commit package',
      aishellBinaryDigest: digest('candidate-binary'),
      aishellToolCatalogDigest: digest('candidate-catalog'),
    },
  },
};

const first = await buildPhase3AttemptManifest(configuration);
const second = await buildPhase3AttemptManifest(structuredClone(configuration));
assert.deepEqual(first, second, 'manifest must be deterministic');
assert.equal(first.attempts.length, 54);
assert.deepEqual(first.tasks, [
  'freshness-cache-repeat-check', 'freshness-cache-input-change',
  'change-impact-direct-dependent', 'change-impact-unresolved-edge',
  'focused-pipeline-recommend-only', 'focused-pipeline-explicit-run',
]);
assert.deepEqual(first.frozenInputs, {
  suiteSHA256: '201958f03dc3b85ea6bfe9cca3b5edfec88124da8a790539639465fab8f46cf7',
  fixtureCatalogSHA256: 'def2454c3e56917812c0cb07c67523a4b90d15c1f24f4834c5ff6fa189b03982',
  taskGoalsSHA256: '810103d0f1358685db035f6f1f711895f411c21e15ba0f8b9de1c3a6761d8e5d',
  executionContractsSHA256: 'aa02c3d604dbad28c182ff9ae1df836b7781d671b199a48f3df3e7a4fe3f6163',
});
assert.equal(JSON.stringify(first).includes('"oracle"'), false, 'attempt manifest must not expose oracle data');
for (const taskID of first.tasks) {
  for (let repetition = 1; repetition <= 3; repetition += 1) {
    const attempts = first.attempts.filter((item) => item.taskID === taskID && item.repetition === repetition);
    assert.deepEqual([...attempts.map(({ arm }) => arm)].sort(), ['candidate', 'current-aishell-0.3.3', 'native']);
    assert.equal(new Set(attempts.map(({ promptSHA256 }) => promptSHA256)).size, 1);
    assert.equal(new Set(attempts.map(({ materializedFixtureSHA256 }) => materializedFixtureSHA256)).size, 1);
  }
}

assert.rejects(() => buildPhase3AttemptManifest({ ...configuration, commonHostCatalogDigest: 'missing' }), /SHA-256/u);
assert.rejects(() => buildPhase3AttemptManifest({
  ...configuration,
  armBindings: { ...configuration.armBindings, native: { ...configuration.armBindings.native, aishellBinaryDigest: digest('wrong') } },
}), /native arm/u);

const root = path.resolve('/benchmark-fixture');
const fileHashes = {
  'src/a.mjs': digest('export const a = 2;\n'),
  'src/b.mjs': digest("import { a } from './a.mjs'; export const b = a;\n"),
  'test/b.test.mjs': digest("import '../src/b.mjs';\n"),
};
const preAttemptManifest = {
  schema: 'aishell.workspace-manifest.v1', root, fileCount: 3, files: fileHashes, digest: digest('pre-state'),
};
const setupEvidence = {
  schema: 'aishell.benchmark-setup-evidence.v1', taskId: 'change-impact-direct-dependent', workspaceRoot: root,
  preStateDigest: preAttemptManifest.digest, checkpoint: 'chk_fixture', cursor: 'ws2:fixture:generation:1',
  runId: 'run_fixture', handles: ['art_one'],
};
const trustedImpactSetup = {
  schema: 'aishell.production-v2-benchmark-setup.v1', tool: 'change_impact', root,
  rootIdentity: 'fixture-root-identity', workspaceCursor: setupEvidence.cursor,
  pathBindings: [{ path: 'src/a.mjs', contentSHA256: fileHashes['src/a.mjs'] }],
  providerIDs: ['static-import'],
};
const preparedImpact = await prepareCandidateRequests({
  taskId: setupEvidence.taskId,
  workspaceRoot: root,
  preAttemptManifest,
  baselineManifest: preAttemptManifest,
  setupEvidence,
  trustedProductionSetup: { change_impact: trustedImpactSetup },
});
assert.equal(preparedImpact.calls.length, 1);
assert.deepEqual(preparedImpact.calls[0].productionRequest, {
  operation: 'analyze', root, workspace_cursor: setupEvidence.cursor,
  changed_paths: [{ path: 'src/a.mjs', content_sha256: fileHashes['src/a.mjs'] }],
  required_providers: ['static-import'], byte_budget: 1_048_576,
});

const runPreAttempt = {
  schema: 'aishell.workspace-manifest.v1', root, fileCount: 2,
  files: { 'check.mjs': digest('check'), 'src/value.mjs': digest('value') }, digest: digest('run-pre-state'),
};
const runSetupEvidence = {
  schema: 'aishell.benchmark-setup-evidence.v1', taskId: 'freshness-cache-repeat-check', workspaceRoot: root,
  preStateDigest: runPreAttempt.digest, checkpoint: 'chk_fixture', cursor: 'ws2:fixture:generation:2',
  runId: 'run_fixture', handles: ['art_one'],
};
const frozenRunRequest = {
  action: 'execute', executable: 'node', arguments: ['check.mjs'], freshness_inputs: ['check.mjs', 'src/value.mjs'],
};
const trustedRunSetup = {
  schema: 'aishell.production-v2-benchmark-setup.v1', tool: 'run_check',
  profileCheck: {
    projectID: 'fixture-project', profileDigest: digest('profile'), checkID: 'test',
    frozenBindingDigest: frozenRunCheckBindingDigest(frozenRunRequest),
  },
  cache: 'prefer', selection: { binding: 'prepare' },
  executionPolicy: { timeoutMs: 300_000, retentionSeconds: 3_600 },
};
const preparedRun = await prepareCandidateRequests({
  taskId: runSetupEvidence.taskId,
  workspaceRoot: root,
  preAttemptManifest: runPreAttempt,
  baselineManifest: runPreAttempt,
  setupEvidence: runSetupEvidence,
  trustedProductionSetup: { run_check: trustedRunSetup },
});
assert.equal(preparedRun.calls[0].productionRequest.invocation.mode, 'profile_check');
assert.equal(preparedRun.calls[0].productionRequest.cache, 'prefer');

const productionRunResult = {
  schemaVersion: 'aishell.run-check.v2',
  planDigest: digest('plan'), selectionDigest: digest('selection'), requestedCheckIDs: ['test'], plannedCheckIDs: ['test'],
  cacheState: 'hit', processesStarted: 0, publications: [], steps: [], lookupEvidence: [{ status: 'hit' }],
};
const productionRunResultBytes = Buffer.from(`${JSON.stringify(productionRunResult)}\n`, 'utf8');
const recorded = recordCandidateProjection({
  preparedCall: preparedRun.calls[0], trustedSetupEvidence: trustedRunSetup,
  productionResult: productionRunResult, productionResultBytes: productionRunResultBytes,
});
assert.deepEqual(recorded.projected, { secondExecutionCount: 0, cacheHit: true, falseFresh: 0 });
assert.deepEqual(recorded.trace.stages.map(({ kind }) => kind), [
  'v1_request', 'trusted_setup', 'v2_request', 'raw_v2_pages', 'projected_v1_result',
]);
assert.deepEqual(normalizeProviderUsage({
  input_tokens: 100, cached_input_tokens: 20, output_tokens: 30, reasoning_output_tokens: 10,
}), {
  source: 'provider', inputTokens: 100, cachedInputTokens: 20,
  outputTokens: 30, reasoningOutputTokens: 10, totalModelTokens: 130,
});
assert.throws(() => normalizeProviderUsage(null), /provider usage is missing/u);

const providerUsageEvent = {
  type: 'turn.completed',
  usage: { input_tokens: 100, cached_input_tokens: 20, output_tokens: 30, reasoning_output_tokens: 10 },
};
const exactProviderTrace = exactByteBinding(Buffer.from(`${JSON.stringify(providerUsageEvent)}\n`, 'utf8'));
assert.deepEqual(extractProviderUsageFromTrace(Buffer.from(exactProviderTrace.base64, 'base64')), {
  format: 'codex-exec-jsonl.v1',
  usage: {
    source: 'provider', inputTokens: 100, cachedInputTokens: 20,
    outputTokens: 30, reasoningOutputTokens: 10, totalModelTokens: 130,
  },
});
assert.equal(extractProviderUsageFromTrace(Buffer.from(`${JSON.stringify({
  type: 'response.completed', response: { usage: providerUsageEvent.usage },
})}\n`)).format, 'openai-responses-jsonl.v1');
const exactAgentResult = exactByteBinding(Buffer.from('{"schema":"aishell.agent-benchmark-report.v1"}\n', 'utf8'));
function adapterTraceForAttempt(attempt) {
  const benchmarkSetupEvidence = {
    schema: 'aishell.benchmark-setup-evidence.v1', taskId: attempt.taskID,
    workspaceRoot: root, preStateDigest: digest(`pre-${attempt.attemptID}`),
  };
  if (attempt.taskID.startsWith('freshness-cache-')) {
    return exactByteBinding(candidateAdapterTraceBytes({
      attemptID: attempt.attemptID, taskID: attempt.taskID, preparedCall: preparedRun.calls[0],
      benchmarkSetupEvidence, trustedSetupEvidence: trustedRunSetup,
      productionResultBytes: recorded.productionResultBytes, trace: recorded.trace,
      projectedResultBytes: recorded.projectedBytes,
    }));
  }
  const frozenRequest = {
    action: attempt.taskID.startsWith('focused-pipeline-') ? 'recommend' : 'analyze',
    changed_paths: attempt.taskID === 'change-impact-unresolved-edge' ? ['src/dynamic.mjs'] : ['src/a.mjs'],
    providers: ['static-import'],
  };
  const trustedSetupEvidence = {
    schema: 'aishell.production-v2-benchmark-setup.v1', tool: 'change_impact', root,
    rootIdentity: `root-${attempt.attemptID}`, workspaceCursor: `ws2:${attempt.attemptID}`,
    pathBindings: frozenRequest.changed_paths.map((changedPath) => changedPath === 'src/dynamic.mjs'
      ? { path: changedPath, expectedAbsent: true }
      : { path: changedPath, contentSHA256: digest(`${attempt.attemptID}:${changedPath}`) }),
    providerIDs: ['static-import'],
    ...(frozenRequest.action === 'recommend' ? { projectID: 'fixture-project', profileDigest: digest(`profile-${attempt.attemptID}`) } : {}),
  };
  const productionRequest = adaptFrozenCapabilityRequest({
    tool: 'change_impact', request: frozenRequest, trustedSetupEvidence,
  });
  const preparedCall = {
    tool: 'change_impact', action: frozenRequest.action, frozenRequest,
    frozenRequestBytes: canonicalJSONBytes(frozenRequest), productionRequest,
    productionRequestBytes: canonicalJSONBytes(productionRequest),
  };
  const candidateID = digest(`candidate-${attempt.attemptID}`);
  const evidenceID = digest(`evidence-${attempt.attemptID}`);
  const items = frozenRequest.action === 'recommend'
    ? [{
      kind: 'focused_candidate', itemID: 'focused', focusedCheckID: 'focused-1', profileCheckID: 'test',
      profileDigest: trustedSetupEvidence.profileDigest, selector: { kind: 'test_path', path: 'test/a.test.mjs' },
    }]
    : attempt.taskID === 'change-impact-unresolved-edge'
      ? [{ kind: 'coverage_gap', itemID: 'gap', coverageGap: { reasonCode: 'dynamic_import' } }]
      : [
        { kind: 'candidate', itemID: 'candidate', candidateID, category: 'references', subject: { kind: 'path', path: 'src/b.mjs' } },
        { kind: 'evidence', itemID: 'evidence', evidenceID, providerID: 'static-import', inputIdentity: 'src/a.mjs',
          subject: { kind: 'path', path: 'src/b.mjs' }, relation: 'lexical_reference', locator: {},
          evidenceStrength: 'lexical_match', summary: 'fixture import' },
        { kind: 'candidate_evidence', itemID: 'edge', candidateID, evidenceID },
      ];
  const completeArtifactBytes = Buffer.concat(items.map((item) => Buffer.concat([canonicalJSONBytes(item), Buffer.from('\n')])));
  const artifact = {
    handle: `art_${digest(attempt.attemptID).slice(0, 16)}`, kind: 'change-impact-jsonl',
    sizeBytes: completeArtifactBytes.length, lineCount: items.length, sha256: sha256Hex(completeArtifactBytes),
    createdAt: '2026-07-22T00:00:00Z', expiresAt: '2026-07-23T00:00:00Z', producer: 'change_impact',
  };
  const productionResult = frozenRequest.action === 'recommend'
    ? {
      schema: 'aishell.change-impact.v2', operation: 'recommend', executionPolicy: 'explicit_run_check_only',
      focusedSetID: `set_${digest(attempt.attemptID).slice(0, 16)}`, focusedSetDigest: digest(`set-${attempt.attemptID}`),
      expiresAt: '2026-07-23T00:00:00Z', freshness: {}, coverage: 'partial', candidateCount: 1,
      stepCount: 0, limitationCount: 0, items, byteBudget: 1_048_576, hasMore: false, continuation: null, artifact,
    }
    : {
      schemaVersion: 'aishell.change-impact.v2', operation: 'analyze', coverage: 'partial', freshness: {}, counts: {},
      items, returnedBytes: completeArtifactBytes.length, omittedBytes: 0, hasMore: false, continuation: null, artifact,
    };
  const productionResultBytes = Buffer.from(`${JSON.stringify(productionResult)}\n`, 'utf8');
  const rawV2Pages = [{ result: productionResult, resultBytes: productionResultBytes }];
  const projected = projectProductionV2Result({
    tool: 'change_impact', frozenRequest, rawV2Pages: [{ result: productionResult }], completeArtifactBytes,
  });
  const projectedResultBytes = canonicalJSONBytes(projected);
  const trace = buildBenchmarkTrace({
    v1RequestBytes: preparedCall.frozenRequestBytes, trustedSetupEvidence,
    v2RequestBytes: preparedCall.productionRequestBytes,
    rawV2Pages, completeArtifactBytes, projectedV1Bytes: projectedResultBytes,
  });
  return exactByteBinding(candidateAdapterTraceBytes({
    attemptID: attempt.attemptID, taskID: attempt.taskID, preparedCall, benchmarkSetupEvidence,
    trustedSetupEvidence, productionResultBytes, trace, completeArtifactBytes, projectedResultBytes,
  }));
}
const attempts = first.attempts.map((attempt) => ({
  attemptID: attempt.attemptID,
  sequence: attempt.sequence,
  taskID: attempt.taskID,
  arm: attempt.arm,
  repetition: attempt.repetition,
  usage: {
    source: 'provider', inputTokens: 100, cachedInputTokens: 20,
    outputTokens: 30, reasoningOutputTokens: 10, totalModelTokens: 130,
  },
  providerTrace: structuredClone(exactProviderTrace),
  providerUsageFormat: 'codex-exec-jsonl.v1',
  agentResult: structuredClone(exactAgentResult),
  adapterTrace: attempt.arm === 'candidate' ? adapterTraceForAttempt(attempt) : null,
  agentExitCode: 0,
  timedOut: false,
  wallMilliseconds: 100,
}));
const validResult = assemblePhase3Result(first, attempts);
assert.equal(validResult.manifestSHA256, sha256Hex(canonicalJSONBytes(first)));
assert.deepEqual(validatePhase3Result(validResult, first), { valid: true, reasons: [] });

let executedAttempts = 0;
const executedResult = await runPhase3Attempts({
  manifest: first,
  executeAttempt: async ({ attempt, prompt, isolation, armBinding }) => {
    assert.equal(sha256Hex(Buffer.from(prompt, 'utf8')), attempt.promptSHA256);
    assert.equal(isolation.modelSnapshot, configuration.modelSnapshot);
    assert.deepEqual(armBinding, first.armBindings[attempt.arm]);
    executedAttempts += 1;
    return structuredClone(attempts[attempt.sequence - 1]);
  },
});
assert.equal(executedAttempts, 54);
assert.equal(executedResult.status, 'valid');

const missingUsage = structuredClone(validResult);
missingUsage.attempts[0].usage = null;
missingUsage.status = 'invalid';
missingUsage.invalidReasons = ['attempt 1 usage is missing'];
assert.deepEqual(validatePhase3Result(missingUsage, first), {
  valid: false, reasons: ['attempt 1 usage is missing'],
});

const usageMismatch = structuredClone(validResult);
usageMismatch.attempts[0].usage.inputTokens = 101;
usageMismatch.attempts[0].usage.totalModelTokens = 131;
usageMismatch.status = 'invalid';
usageMismatch.invalidReasons = ['attempt 1 usage differs from provider trace'];
assert.deepEqual(validatePhase3Result(usageMismatch, first), {
  valid: false, reasons: ['attempt 1 usage differs from provider trace'],
});

const unsupportedUsageTrace = structuredClone(validResult);
unsupportedUsageTrace.attempts[0].providerTrace = exactByteBinding(Buffer.from(
  `${JSON.stringify({ type: 'provider.completed', usage: providerUsageEvent.usage })}\n`, 'utf8',
));
unsupportedUsageTrace.status = 'invalid';
unsupportedUsageTrace.invalidReasons = ['provider trace must contain exactly one supported completed usage event'];
assert.deepEqual(validatePhase3Result(unsupportedUsageTrace, first), {
  valid: false, reasons: ['provider trace must contain exactly one supported completed usage event'],
});

const changedTrace = structuredClone(validResult);
changedTrace.attempts[0].providerTrace.base64 = Buffer.from('different').toString('base64');
changedTrace.status = 'invalid';
changedTrace.invalidReasons = ['attempt 1 provider trace bytes/digest mismatch'];
assert.deepEqual(validatePhase3Result(changedTrace, first), {
  valid: false, reasons: ['attempt 1 provider trace bytes/digest mismatch'],
});

const missingAdapter = structuredClone(validResult);
const candidateIndex = missingAdapter.attempts.findIndex(({ arm }) => arm === 'candidate');
missingAdapter.attempts[candidateIndex].adapterTrace = null;
missingAdapter.status = 'invalid';
missingAdapter.invalidReasons = [`attempt ${candidateIndex + 1} candidate adapter trace is missing`];
assert.deepEqual(validatePhase3Result(missingAdapter, first), {
  valid: false, reasons: [`attempt ${candidateIndex + 1} candidate adapter trace is missing`],
});

const reusedAdapter = structuredClone(validResult);
const candidateIndices = reusedAdapter.attempts.map(({ arm }, index) => arm === 'candidate' ? index : -1).filter((index) => index >= 0);
const differentTaskCandidate = candidateIndices.find((index) =>
  reusedAdapter.attempts[index].taskID !== reusedAdapter.attempts[candidateIndices[0]].taskID);
reusedAdapter.attempts[differentTaskCandidate].adapterTrace = structuredClone(reusedAdapter.attempts[candidateIndices[0]].adapterTrace);
reusedAdapter.status = 'invalid';
reusedAdapter.invalidReasons = [`attempt ${differentTaskCandidate + 1} adapter trace belongs to a different attempt`];
assert.deepEqual(validatePhase3Result(reusedAdapter, first), {
  valid: false, reasons: [`attempt ${differentTaskCandidate + 1} adapter trace belongs to a different attempt`],
});

const invalidProductionSchema = structuredClone(validResult);
const analyzeCandidateIndex = candidateIndices.find((index) =>
  invalidProductionSchema.attempts[index].taskID === 'change-impact-direct-dependent');
const invalidSchemaEnvelope = JSON.parse(Buffer.from(
  invalidProductionSchema.attempts[analyzeCandidateIndex].adapterTrace.base64, 'base64',
));
const invalidProductionResult = JSON.parse(Buffer.from(
  invalidSchemaEnvelope.attemptBinding.productionResult.base64, 'base64',
));
invalidProductionResult.schemaVersion = 'aishell.change-impact.invalid';
const invalidProductionBinding = exactByteBinding(Buffer.from(JSON.stringify(invalidProductionResult), 'utf8'));
invalidSchemaEnvelope.attemptBinding.productionResult = invalidProductionBinding;
invalidSchemaEnvelope.productionTrace.stages[3].pages[0].resultBytes = invalidProductionBinding;
invalidSchemaEnvelope.productionTrace.stages[3].pages[0].sha256 = invalidProductionBinding.sha256;
invalidProductionSchema.attempts[analyzeCandidateIndex].adapterTrace = exactByteBinding(canonicalJSONBytes(invalidSchemaEnvelope));
invalidProductionSchema.status = 'invalid';
invalidProductionSchema.invalidReasons = ['projection scope mismatch'];
assert.deepEqual(validatePhase3Result(invalidProductionSchema, first), {
  valid: false, reasons: ['projection scope mismatch'],
});

const fabricatedProjection = structuredClone(validResult);
const unresolvedCandidateIndex = candidateIndices.find((index) =>
  fabricatedProjection.attempts[index].taskID === 'change-impact-unresolved-edge');
const sourceProjectionEnvelope = JSON.parse(Buffer.from(
  fabricatedProjection.attempts[analyzeCandidateIndex].adapterTrace.base64, 'base64',
));
const targetProjectionEnvelope = JSON.parse(Buffer.from(
  fabricatedProjection.attempts[unresolvedCandidateIndex].adapterTrace.base64, 'base64',
));
targetProjectionEnvelope.projectedResult = sourceProjectionEnvelope.projectedResult;
targetProjectionEnvelope.productionTrace.stages[4].bytes = sourceProjectionEnvelope.projectedResult;
targetProjectionEnvelope.productionTrace.stages[4].sha256 = sourceProjectionEnvelope.projectedResult.sha256;
fabricatedProjection.attempts[unresolvedCandidateIndex].adapterTrace = exactByteBinding(canonicalJSONBytes(targetProjectionEnvelope));
fabricatedProjection.status = 'invalid';
fabricatedProjection.invalidReasons = [
  `attempt ${unresolvedCandidateIndex + 1} adapter trace projected result differs from production adapter`,
];
assert.deepEqual(validatePhase3Result(fabricatedProjection, first), {
  valid: false,
  reasons: [`attempt ${unresolvedCandidateIndex + 1} adapter trace projected result differs from production adapter`],
});

assert.throws(() => recordCandidateProjection({
  preparedCall: preparedRun.calls[0], trustedSetupEvidence: trustedRunSetup, productionResult: productionRunResult,
}), /production result exact bytes are required/u);
assert.equal(recorded.productionResultBytes.equals(productionRunResultBytes), true, 'original result bytes must be retained');

const oracleSentinels = ['ORACLE_VALUE_SENTINEL_7f41', 'ORACLE_SECRET_PATH_92b3'];
const syntheticFixtureMaterial = oracleFreeFixtureMaterial({
  id: 'sentinel-fixture', seedFiles: { 'src/value.txt': 'safe fixture bytes' },
}, {
  mutation: [{ op: 'write', path: 'src/value.txt', content: 'safe mutation' }],
  oracle: { allowedAssertionKey: oracleSentinels[0], secretPath: oracleSentinels[1] },
});
const visibleSurfaces = {
  prompt: await (async () => {
    const captured = [];
    await runPhase3Attempts({
      manifest: first,
      executeAttempt: async ({ prompt, attempt }) => {
        captured.push(prompt);
        return structuredClone(attempts[attempt.sequence - 1]);
      },
    });
    return captured.join('\n---attempt---\n');
  })(),
  request: Buffer.concat(first.tasks.map((taskID) => Buffer.from(JSON.stringify(taskID.startsWith('freshness-cache-')
    ? frozenRunRequest
    : {
      action: taskID.startsWith('focused-pipeline-') ? 'recommend' : 'analyze',
      changed_paths: taskID === 'change-impact-unresolved-edge' ? ['src/dynamic.mjs'] : ['src/a.mjs'],
      providers: ['static-import'],
    })))),
  manifest: first,
  trace: Buffer.concat(attempts.filter(({ arm }) => arm === 'candidate')
    .map(({ adapterTrace }) => Buffer.from(adapterTrace.base64, 'base64'))),
  fixture: syntheticFixtureMaterial,
  allowedAssertionKey: { assertions: { cacheHit: '<observed cacheHit>' } },
};
assert.equal(assertNoOracleValueSentinels(visibleSurfaces, oracleSentinels), true);
for (const name of ['prompt', 'request', 'manifest', 'trace']) {
  assert.throws(() => assertNoOracleValueSentinels({
    ...visibleSurfaces,
    [name]: Buffer.concat([Buffer.from(typeof visibleSurfaces[name] === 'string'
      ? visibleSurfaces[name] : JSON.stringify(visibleSurfaces[name])), Buffer.from(oracleSentinels[0])]),
  }, oracleSentinels), new RegExp(`oracle value sentinel leaked into ${name}`, 'u'));
}
assert.throws(() => assertNoOracleValueSentinels({
  trace: canonicalJSONBytes({ nestedExactBytes: exactByteBinding(Buffer.from(oracleSentinels[0], 'utf8')) }),
}, oracleSentinels), /oracle value sentinel leaked into trace/u, 'base64-bound exact bytes must also be audited');

const schema = JSON.parse(await readFile(new URL('./phase3-representative-result.schema.json', import.meta.url), 'utf8'));
assert.equal(schema.$schema, 'https://json-schema.org/draft/2020-12/schema');
assert.equal(schema.properties.attempts.minItems, 54);
assert.equal(schema.properties.attempts.maxItems, 54);
assert.equal(schema.$defs.usage.properties.source.const, 'provider');
assert.equal(schema.$defs.attempt.additionalProperties, false);

process.stdout.write(JSON.stringify({
  schema: 'aishell.phase3_representative_runner_self_test.v1', attempts: first.attempts.length,
  candidateAdapters: preparedImpact.calls.length + preparedRun.calls.length, status: 'valid',
}) + '\n');
