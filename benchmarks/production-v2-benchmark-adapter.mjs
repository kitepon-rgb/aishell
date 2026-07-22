import { createHash } from 'node:crypto';
import path from 'node:path';

const SHA256 = /^[a-f0-9]{64}$/u;
const SETUP_SCHEMA = 'aishell.production-v2-benchmark-setup.v1';
const V1_SCHEMA = 'aishell.change-impact.v1';

export class BenchmarkAdapterError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'BenchmarkAdapterError';
    this.code = code;
  }
}

function failSetup(message) {
  throw new BenchmarkAdapterError('BENCHMARK_SETUP_INVALID', message);
}

function failProjection(message) {
  throw new BenchmarkAdapterError('BENCHMARK_PROJECTION_INVALID', message);
}

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function exactKeys(value, keys, fail, label) {
  if (!plainObject(value)) fail(`${label} must be an object`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail(`${label} has invalid fields`);
  }
}

function allowedKeys(value, required, optional, fail, label) {
  if (!plainObject(value)) fail(`${label} must be an object`);
  const keys = Object.keys(value);
  if (required.some((key) => !keys.includes(key)) || keys.some((key) => !required.includes(key) && !optional.includes(key))) {
    fail(`${label} has invalid fields`);
  }
}

/** Deterministic UTF-8 JSON with every object key sorted by unsigned UTF-8 bytes. */
export function canonicalJSONBytes(value) {
  // JavaScript's key sort is UTF-16. Re-sort explicitly by UTF-8 for non-ASCII keys.
  const compare = (left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right));
  const normalize = (input, seen = new Set()) => {
    if (input === null || typeof input === 'string' || typeof input === 'boolean') return input;
    if (typeof input === 'number' && Number.isSafeInteger(input)) return input;
    if (Array.isArray(input)) return input.map((item) => normalize(item, seen));
    if (!plainObject(input) || seen.has(input)) throw new TypeError('value is not canonical JSON');
    seen.add(input);
    const output = {};
    for (const key of Object.keys(input).sort(compare)) {
      if (input[key] === undefined) throw new TypeError('undefined is not canonical JSON');
      output[key] = normalize(input[key], seen);
    }
    seen.delete(input);
    return output;
  };
  // JSON.stringify preserves insertion order for non-integer keys. Contract field names are
  // non-integer; reject integer-like object keys so the engine cannot silently reorder them.
  const normalized = normalize(value);
  const rejectIntegerKeys = (input) => {
    if (Array.isArray(input)) return input.forEach(rejectIntegerKeys);
    if (!plainObject(input)) return;
    for (const [key, nested] of Object.entries(input)) {
      if (/^(0|[1-9][0-9]*)$/u.test(key)) throw new TypeError('integer-like object keys are not canonical JSON');
      rejectIntegerKeys(nested);
    }
  };
  rejectIntegerKeys(normalized);
  return Buffer.from(JSON.stringify(normalized), 'utf8');
}

export function sha256Hex(bytes) {
  if (!(typeof bytes === 'string' || ArrayBuffer.isView(bytes) || bytes instanceof ArrayBuffer)) {
    throw new TypeError('sha256 input must be bytes or a string');
  }
  return createHash('sha256').update(bytes).digest('hex');
}

export function canonicalDigest(value) {
  return sha256Hex(canonicalJSONBytes(value));
}

export function frozenRunCheckBindingDigest(request) {
  exactKeys(request, ['action', 'executable', 'arguments', 'freshness_inputs'], failSetup, 'frozen run_check request');
  if (request.action !== 'execute' || typeof request.executable !== 'string' || request.executable.length === 0
    || !validStringArray(request.arguments, false) || !validStringArray(request.freshness_inputs, false)) {
    failSetup('invalid frozen run_check request');
  }
  return canonicalDigest({
    executable: request.executable,
    arguments: request.arguments,
    freshness_inputs: request.freshness_inputs,
  });
}

function validStringArray(value, unique = true) {
  return Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === 'string' && item.length > 0)
    && (!unique || new Set(value).size === value.length);
}

function validDigest(value) {
  return typeof value === 'string' && SHA256.test(value);
}

function validPath(value) {
  return typeof value === 'string' && value.length > 0 && !value.startsWith('/') && !value.includes('\\')
    && value.split('/').every((part) => part.length > 0 && part !== '.' && part !== '..');
}

function validAbsoluteRoot(value) {
  return typeof value === 'string' && value.length > 0 && Buffer.byteLength(value) <= 4_096
    && !value.includes('\0') && path.isAbsolute(value)
    && path.normalize(value) === value
    && (value === path.parse(value).root || !value.endsWith(path.sep));
}

function adaptChangeImpact(request, setup) {
  exactKeys(request, ['action', 'changed_paths', 'providers'], failSetup, 'frozen change_impact request');
  if (!['analyze', 'recommend'].includes(request.action) || !validStringArray(request.changed_paths)
    || !request.changed_paths.every(validPath) || !validStringArray(request.providers)) {
    failSetup('invalid frozen change_impact request');
  }
  const common = ['schema', 'tool', 'root', 'rootIdentity', 'workspaceCursor', 'pathBindings', 'providerIDs'];
  const setupKeys = request.action === 'recommend' ? [...common, 'projectID', 'profileDigest'] : common;
  exactKeys(setup, setupKeys, failSetup, 'trusted change_impact setup');
  if (setup.schema !== SETUP_SCHEMA || setup.tool !== 'change_impact' || !validAbsoluteRoot(setup.root)
    || typeof setup.rootIdentity !== 'string' || setup.rootIdentity.length === 0
    || Buffer.byteLength(setup.rootIdentity) > 4_096 || setup.rootIdentity.includes('\0')
    || typeof setup.workspaceCursor !== 'string' || setup.workspaceCursor.length === 0 || !validStringArray(setup.providerIDs)) {
    failSetup('invalid trusted change_impact setup');
  }
  if (!Array.isArray(setup.pathBindings) || setup.pathBindings.length === 0) failSetup('invalid path bindings');
  const bindings = new Map();
  for (const binding of setup.pathBindings) {
    if (!plainObject(binding) || !validPath(binding.path) || bindings.has(binding.path)) failSetup('invalid or duplicate path binding');
    if (Object.hasOwn(binding, 'contentSHA256')) {
      exactKeys(binding, ['path', 'contentSHA256'], failSetup, 'path binding');
      if (!validDigest(binding.contentSHA256)) failSetup('invalid path binding SHA-256');
      bindings.set(binding.path, { path: binding.path, content_sha256: binding.contentSHA256 });
    } else {
      exactKeys(binding, ['path', 'expectedAbsent'], failSetup, 'path binding');
      if (binding.expectedAbsent !== true) failSetup('invalid absence binding');
      bindings.set(binding.path, { path: binding.path, expected_absent: true });
    }
  }
  if (bindings.size !== request.changed_paths.length || request.changed_paths.some((path) => !bindings.has(path))) {
    failSetup('changed paths do not exactly match trusted setup');
  }
  if (setup.providerIDs.length !== request.providers.length
    || request.providers.some((provider) => !setup.providerIDs.includes(provider))) {
    failSetup('providers do not exactly match trusted setup');
  }
  const output = {
    operation: request.action,
    root: setup.root,
    workspace_cursor: setup.workspaceCursor,
    changed_paths: request.changed_paths.map((path) => bindings.get(path)),
    required_providers: [...request.providers],
    byte_budget: 1_048_576,
  };
  if (request.action === 'recommend') {
    if (typeof setup.projectID !== 'string' || setup.projectID.length === 0 || !validDigest(setup.profileDigest)) {
      failSetup('recommend requires an exact project/profile binding');
    }
    output.project_id = setup.projectID;
    output.profile_digest = setup.profileDigest;
  }
  return output;
}

function adaptRunCheck(request, setup) {
  const bindingDigest = frozenRunCheckBindingDigest(request);
  exactKeys(setup, ['schema', 'tool', 'profileCheck', 'cache', 'selection', 'executionPolicy'], failSetup, 'trusted run_check setup');
  if (setup.schema !== SETUP_SCHEMA || setup.tool !== 'run_check'
    || !['off', 'prefer', 'only', 'refresh'].includes(setup.cache)) failSetup('invalid trusted run_check setup');
  exactKeys(setup.profileCheck, ['projectID', 'profileDigest', 'checkID', 'frozenBindingDigest'], failSetup, 'profile check binding');
  if (typeof setup.profileCheck.projectID !== 'string' || setup.profileCheck.projectID.length === 0
    || !validDigest(setup.profileCheck.profileDigest) || typeof setup.profileCheck.checkID !== 'string'
    || setup.profileCheck.checkID.length === 0 || setup.profileCheck.frozenBindingDigest !== bindingDigest) {
    failSetup('frozen command material does not match the trusted profile check binding');
  }
  exactKeys(setup.selection, ['binding'], failSetup, 'run_check selection');
  if (setup.selection.binding !== 'prepare') failSetup('run_check selection must be prepare');
  exactKeys(setup.executionPolicy, ['timeoutMs', 'retentionSeconds'], failSetup, 'run_check execution policy');
  if (!Number.isInteger(setup.executionPolicy.timeoutMs) || setup.executionPolicy.timeoutMs < 1
    || setup.executionPolicy.timeoutMs > 3_600_000 || !Number.isInteger(setup.executionPolicy.retentionSeconds)
    || setup.executionPolicy.retentionSeconds < 1 || setup.executionPolicy.retentionSeconds > 604_800) {
    failSetup('invalid run_check execution policy');
  }
  return {
    schema: 'aishell.run-check.v2',
    invocation: {
      mode: 'profile_check', project_id: setup.profileCheck.projectID,
      profile_digest: setup.profileCheck.profileDigest, check_id: setup.profileCheck.checkID,
    },
    dispatch: { mode: 'sync' },
    cache: setup.cache,
    execution_policy: { timeout_ms: setup.executionPolicy.timeoutMs, retention_seconds: setup.executionPolicy.retentionSeconds },
    selection: { binding: 'prepare' },
  };
}

export function adaptFrozenCapabilityRequest({ tool, request, trustedSetupEvidence }) {
  if (tool === 'change_impact') return adaptChangeImpact(request, trustedSetupEvidence);
  if (tool === 'run_check') return adaptRunCheck(request, trustedSetupEvidence);
  failSetup(`unsupported benchmark tool: ${tool}`);
}

function rawPageEntries(pages, requireResultBytes = false) {
  if (!Array.isArray(pages) || pages.length === 0) failProjection('raw v2 pages are required');
  return pages.map((page, index) => {
    const required = requireResultBytes ? ['result', 'resultBytes'] : ['result'];
    allowedKeys(page, required, ['requestToken'], failProjection, `raw page ${index}`);
    if (index === 0 ? (Object.hasOwn(page, 'requestToken') && page.requestToken !== null) : typeof page.requestToken !== 'string') {
      failProjection('invalid page token chain');
    }
    return page;
  });
}

function validateArtifact(pages, artifactBytes) {
  if (!(typeof artifactBytes === 'string' || Buffer.isBuffer(artifactBytes) || ArrayBuffer.isView(artifactBytes))) {
    failProjection('complete artifact bytes are required');
  }
  const complete = Buffer.from(artifactBytes);
  const digest = sha256Hex(complete);
  const itemChunks = [];
  let priorToken = null;
  pages.forEach((page, index) => {
    const result = page.result;
    if (!plainObject(result) || !Array.isArray(result.items) || !plainObject(result.artifact)
      || result.artifact.sha256 !== digest || result.artifact.sizeBytes !== complete.length) {
      failProjection('page/artifact digest mismatch');
    }
    if (index > 0 && page.requestToken !== priorToken) failProjection('invalid page token chain');
    if (index > 0) {
      const first = pages[0].result;
      for (const key of ['operation', 'coverage', 'executionPolicy', 'focusedSetID', 'focusedSetDigest']) {
        if (Object.hasOwn(first, key) && result[key] !== first[key]) failProjection(`page ${key} binding changed`);
      }
    }
    const expectedMore = index < pages.length - 1;
    if (result.hasMore !== expectedMore || (expectedMore ? typeof result.continuation !== 'string' : result.continuation !== null)) {
      failProjection('incomplete or invalid page chain');
    }
    priorToken = result.continuation;
    const chunk = Buffer.concat(result.items.map((item) => Buffer.concat([canonicalJSONBytes(item), Buffer.from('\n')])));
    if (Object.hasOwn(result, 'returnedBytes') && result.returnedBytes !== chunk.length) failProjection('page byte count mismatch');
    itemChunks.push(chunk);
  });
  if (!Buffer.concat(itemChunks).equals(complete)) failProjection('page items do not equal complete artifact');
  return { complete, digest, items: pages.flatMap(({ result }) => result.items) };
}

const ANALYZE_TOP = ['schemaVersion', 'operation', 'coverage', 'freshness', 'counts', 'items', 'returnedBytes', 'omittedBytes', 'hasMore', 'continuation', 'artifact'];
const RECOMMEND_TOP = ['schema', 'operation', 'executionPolicy', 'focusedSetID', 'focusedSetDigest', 'expiresAt', 'freshness', 'coverage', 'candidateCount', 'stepCount', 'limitationCount', 'items', 'byteBudget', 'hasMore', 'continuation', 'artifact'];

function pathFromSubject(subject) {
  if (!plainObject(subject) || typeof subject.kind !== 'string') failProjection('invalid candidate subject');
  if (subject.kind === 'path' || subject.kind === 'resource' || subject.kind === 'test') {
    exactKeys(subject, ['kind', 'path'], failProjection, 'candidate subject');
    if (!validPath(subject.path)) failProjection('invalid candidate path');
    return subject.path;
  }
  if (subject.kind === 'symbol') {
    allowedKeys(subject, ['kind', 'path', 'startOffset', 'endOffset', 'name'], ['stableID'], failProjection, 'symbol subject');
    if (!validPath(subject.path)) failProjection('invalid symbol path');
    return subject.path;
  }
  if (subject.kind === 'target') {
    exactKeys(subject, ['kind', 'ecosystemID', 'profileIdentity', 'manifestPath', 'declaredID'], failProjection, 'manifest subject');
    return null;
  }
  if (subject.kind === 'module' || subject.kind === 'package') {
    exactKeys(subject, ['kind', 'ecosystemID', 'manifestPath', 'declaredID'], failProjection, 'manifest subject');
    return null;
  }
  failProjection('unknown candidate subject kind');
}

function projectAnalyze(pages, items) {
  const candidates = new Map();
  const evidence = new Map();
  const edges = [];
  let gaps = 0;
  for (const item of items) {
    if (!plainObject(item) || typeof item.kind !== 'string') failProjection('invalid analyze item');
    if (item.kind === 'candidate') {
      exactKeys(item, ['kind', 'itemID', 'candidateID', 'category', 'subject'], failProjection, 'candidate');
      if (!validDigest(item.candidateID) || candidates.has(item.candidateID)
        || !['references', 'dependencies', 'related_tests', 'build_targets'].includes(item.category)) failProjection('unknown or duplicate candidate');
      candidates.set(item.candidateID, { category: item.category, path: pathFromSubject(item.subject) });
    } else if (item.kind === 'evidence') {
      exactKeys(item, ['kind', 'itemID', 'evidenceID', 'providerID', 'inputIdentity', 'subject', 'relation', 'locator', 'evidenceStrength', 'summary'], failProjection, 'evidence');
      if (!validDigest(item.evidenceID) || evidence.has(item.evidenceID) || typeof item.providerID !== 'string' || item.providerID.length === 0) {
        failProjection('invalid or duplicate evidence');
      }
      if (!['lexical_reference', 'declared_dependency', 'contains_source', 'contains_test', 'naming_heuristic'].includes(item.relation)
        || !['heuristic', 'lexical_match', 'declared_edge'].includes(item.evidenceStrength)) {
        failProjection('unknown evidence relation or strength');
      }
      evidence.set(item.evidenceID, item.providerID);
    } else if (item.kind === 'candidate_evidence') {
      exactKeys(item, ['kind', 'itemID', 'candidateID', 'evidenceID'], failProjection, 'candidate_evidence');
      edges.push(item);
    } else if (item.kind === 'coverage_gap') {
      exactKeys(item, ['kind', 'itemID', 'coverageGap'], failProjection, 'coverage_gap');
      gaps += 1;
    } else if (item.kind === 'input_path') {
      exactKeys(item, ['kind', 'itemID', 'changedPath'], failProjection, 'input_path');
    } else if (item.kind === 'input_symbol') {
      exactKeys(item, ['kind', 'itemID', 'changedSymbol'], failProjection, 'input_symbol');
    } else if (item.kind === 'required_provider') {
      exactKeys(item, ['kind', 'itemID', 'providerID'], failProjection, 'required_provider');
    } else if (item.kind === 'freshness_binding') {
      exactKeys(item, ['kind', 'itemID', 'freshnessBinding'], failProjection, 'freshness_binding');
    } else if (item.kind === 'provider_report') {
      exactKeys(item, ['kind', 'itemID', 'providerReport'], failProjection, 'provider_report');
    } else {
      failProjection('unknown analyze edge or item');
    }
  }
  const selected = new Set();
  const providers = new Set();
  for (const edge of edges) {
    const candidate = candidates.get(edge.candidateID);
    const provider = evidence.get(edge.evidenceID);
    if (!candidate || !provider) failProjection('edge refers to an unknown candidate or evidence');
    if (candidate.path && ['references', 'dependencies', 'related_tests'].includes(candidate.category)) {
      selected.add(candidate.path);
      providers.add(provider);
    }
  }
  return {
    schemaVersion: V1_SCHEMA,
    impactedPaths: [...selected].sort(utf8Compare),
    provenance: [...providers].sort(utf8Compare).join(','),
    unknowns: gaps,
    silentCompletenessClaims: pages.some(({ result }) => result.coverage === 'complete') && gaps > 0 ? 1 : 0,
  };
}

function projectRecommend(items, envelope) {
  if (envelope.executionPolicy !== 'explicit_run_check_only') failProjection('recommend execution policy missing or invalid');
  const checks = new Set();
  for (const item of items) {
    if (!plainObject(item) || typeof item.kind !== 'string') failProjection('invalid recommend item');
    if (item.kind === 'focused_candidate') {
      exactKeys(item, ['kind', 'itemID', 'focusedCheckID', 'profileCheckID', 'profileDigest', 'selector'], failProjection, 'focused candidate');
      if (!plainObject(item.selector) || typeof item.selector.kind !== 'string') failProjection('invalid focused selector');
      if (item.selector.kind === 'test_path') {
        exactKeys(item.selector, ['kind', 'path'], failProjection, 'test path selector');
        if (!validPath(item.selector.path)) failProjection('invalid recommended test path');
        checks.add(item.selector.path);
      } else if (item.selector.kind === 'profile_check') {
        exactKeys(item.selector, ['kind', 'id'], failProjection, 'profile check selector');
      } else if (item.selector.kind === 'target') {
        exactKeys(item.selector, ['kind', 'ecosystemID', 'profileIdentity', 'manifestPath', 'declaredID'], failProjection, 'target selector');
      } else {
        failProjection('unknown focused selector');
      }
    } else if (item.kind === 'focused_step') {
      exactKeys(item, ['kind', 'itemID', 'focusedCheckID', 'step'], failProjection, 'focused step');
    } else if (item.kind === 'dependency_edge') {
      exactKeys(item, ['kind', 'itemID', 'focusedCheckID', 'dependsOn'], failProjection, 'dependency edge');
    } else if (item.kind === 'manifest_binding') {
      exactKeys(item, ['kind', 'itemID', 'manifest'], failProjection, 'manifest binding');
    } else if (item.kind === 'impact_evidence') {
      exactKeys(item, ['kind', 'itemID', 'focusedCheckID', 'evidence'], failProjection, 'impact evidence');
    } else if (item.kind === 'coverage_gap') {
      exactKeys(item, ['kind', 'itemID', 'coverageGap'], failProjection, 'recommend coverage gap');
    } else {
      failProjection('unknown recommend candidate or item');
    }
  }
  return { schemaVersion: V1_SCHEMA, recommendedChecks: [...checks].sort(utf8Compare), executionRequiresOptIn: true };
}

function utf8Compare(left, right) {
  return Buffer.compare(Buffer.from(left), Buffer.from(right));
}

function projectRunCheck(result) {
  exactKeys(result, ['schemaVersion', 'planDigest', 'selectionDigest', 'requestedCheckIDs', 'plannedCheckIDs', 'cacheState', 'processesStarted', 'publications', 'steps', 'lookupEvidence'], failProjection, 'run_check result');
  if (result.schemaVersion !== 'aishell.run-check.v2' || !Number.isInteger(result.processesStarted) || result.processesStarted < 0
    || !['disabled', 'hit', 'miss_executed', 'refresh_executed', 'ineligible'].includes(result.cacheState)
    || !Array.isArray(result.lookupEvidence)) failProjection('invalid run_check production result');
  const cacheHit = result.cacheState === 'hit';
  const inconsistentHit = cacheHit && (result.processesStarted !== 0
    || result.lookupEvidence.some((entry) => entry?.status !== 'hit'));
  return { secondExecutionCount: result.processesStarted, cacheHit, falseFresh: inconsistentHit ? 1 : 0 };
}

export function projectProductionV2Result({ tool, frozenRequest, productionResult, rawV2Pages, completeArtifactBytes }) {
  if (tool === 'run_check') {
    if (rawV2Pages !== undefined || completeArtifactBytes !== undefined) failProjection('run_check does not accept change_impact pages');
    return projectRunCheck(productionResult);
  }
  if (tool !== 'change_impact') failProjection(`unsupported projection tool: ${tool}`);
  exactKeys(frozenRequest, ['action', 'changed_paths', 'providers'], failProjection, 'frozen projection request');
  if (!['analyze', 'recommend'].includes(frozenRequest.action)) failProjection('unknown projection action');
  const pages = rawPageEntries(rawV2Pages);
  const expectedTop = frozenRequest.action === 'analyze' ? ANALYZE_TOP : RECOMMEND_TOP;
  for (const { result } of pages) {
    exactKeys(result, expectedTop, failProjection, `${frozenRequest.action} result envelope`);
    const schema = result.schemaVersion ?? result.schema;
    if (schema !== 'aishell.change-impact.v2' || result.operation !== frozenRequest.action
      || !['complete', 'partial'].includes(result.coverage)
      || (frozenRequest.action === 'recommend' && result.executionPolicy !== 'explicit_run_check_only')) {
      failProjection('projection scope mismatch');
    }
  }
  const { items } = validateArtifact(pages, completeArtifactBytes);
  return frozenRequest.action === 'analyze' ? projectAnalyze(pages, items) : projectRecommend(items, pages[0].result);
}

function exactBytes(value, label) {
  if (Buffer.isBuffer(value)) return Buffer.from(value);
  if (typeof value === 'string' || ArrayBuffer.isView(value)) return Buffer.from(value);
  throw new TypeError(`${label} must be exact bytes`);
}

export function buildBenchmarkTrace({
  v1RequestBytes, trustedSetupEvidence, v2RequestBytes, rawV2Pages,
  completeArtifactBytes, projectedV1Bytes,
}) {
  const v1 = exactBytes(v1RequestBytes, 'v1 request');
  const v2 = exactBytes(v2RequestBytes, 'v2 request');
  const artifact = exactBytes(completeArtifactBytes, 'complete artifact');
  const projected = exactBytes(projectedV1Bytes, 'projected v1 result');
  const pages = rawPageEntries(rawV2Pages, true);
  const exactPages = pages.map((page, index) => {
    const bytes = exactBytes(page.resultBytes, `raw v2 page ${index}`);
    let parsed;
    try {
      parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    } catch {
      failProjection(`raw v2 page ${index} is not exact UTF-8 JSON`);
    }
    let parsedCanonical;
    let resultCanonical;
    try {
      parsedCanonical = canonicalJSONBytes(parsed);
      resultCanonical = canonicalJSONBytes(page.result);
    } catch {
      failProjection(`raw v2 page ${index} is not canonical JSON data`);
    }
    if (!parsedCanonical.equals(resultCanonical)) failProjection(`raw v2 page ${index} bytes/object mismatch`);
    return { requestToken: page.requestToken ?? null, resultBytes: bytes, sha256: sha256Hex(bytes) };
  });
  // Validate only the token chain here. Projection performs semantic and artifact verification.
  pages.forEach((page, index) => {
    if (index > 0 && page.requestToken !== pages[index - 1].result?.continuation) failProjection('invalid trace page token chain');
  });
  return {
    schema: 'aishell.production-v2-benchmark-trace.v1',
    stages: [
      { kind: 'v1_request', bytes: v1, sha256: sha256Hex(v1) },
      { kind: 'trusted_setup', sha256: canonicalDigest(trustedSetupEvidence) },
      { kind: 'v2_request', bytes: v2, sha256: sha256Hex(v2) },
      {
        kind: 'raw_v2_pages', pages: exactPages,
        pageTokenChain: pages.map(({ requestToken, result }) => ({ requestToken: requestToken ?? null, continuation: result.continuation ?? null })),
        completeArtifactSHA256: sha256Hex(artifact),
      },
      { kind: 'projected_v1_result', bytes: projected, sha256: sha256Hex(projected) },
    ],
  };
}
