#!/usr/bin/env node

import path from 'node:path';

function requireString(value, label) {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`invalid setup evidence: ${label}`);
  return value;
}

function mutationPaths(scenario) {
  return [...new Set(scenario.mutation.flatMap((item) => [item.path, item.from, item.to].filter(Boolean)))].sort();
}

function replacementChanges(taskId, expected, preAttempt, baseline) {
  const replacements = expected.apply ?? (taskId === 'change-set-stale-sha'
    ? [['src/a.txt', 'A2\n'], ['src/b.txt', 'B2\n']]
    : null);
  if (!replacements) throw new Error(`no frozen replacements: ${taskId}`);
  const shaSource = taskId === 'change-set-stale-sha' ? baseline : preAttempt;
  if (!shaSource) throw new Error(`baseline manifest required for request: ${taskId}`);
  return replacements.map(([file, content]) => {
    const expectedSha = shaSource.files[file];
    if (!/^[a-f0-9]{64}$/u.test(expectedSha ?? '')) throw new Error(`fixture target missing from manifest: ${file}`);
    return {path:file, expected_sha:expectedSha, content};
  });
}

function requestValues({ taskId, fixture, scenario, expected, root, preAttempt, baseline, setup }) {
  const paths = mutationPaths(scenario);
  const seedTargets = Object.keys(fixture.seedFiles).sort();
  const materializedTargets = Object.keys(preAttempt.files).sort();
  const cursor = () => requireString(setup.cursor, 'cursor');
  const handles = () => {
    if (!Array.isArray(setup.handles) || setup.handles.length < 1 || setup.handles.some((item) => !/^art_[a-z0-9_-]+$/u.test(item))) {
      throw new Error('invalid setup evidence: handles');
    }
    return [...setup.handles];
  };
  return {
    path:root,
    checkpoint:() => requireString(setup.checkpoint, 'checkpoint'),
    since_cursor:cursor,
    git_mode:'porcelain-v2',
    profile_mode:taskId === 'project-profile-warm-hit' ? 'warm' : 'refresh',
    base:expected.base ?? 'main',
    other:scenario.mutation.find(({branch}) => branch)?.branch ?? 'candidate',
    queries:taskId === 'batch-context-multi-query'
      ? ['needle', 'export\\s+const', 'src/**,test/**']
      : [taskId === 'semantic-context-stale-after-edit' ? 'references:renamed' : 'references:target'],
    targets:materializedTargets,
    byte_budget:16384,
    executable:'node',
    arguments:fixture.id === 'freshness-cache' ? ['check.mjs']
      : fixture.id === 'async-process' ? ['slow.mjs'] : ['result.json'],
    freshness_inputs:fixture.id === 'freshness-cache' ? ['check.mjs', 'src/value.mjs'] : seedTargets,
    diagnostic_adapter:'fixture-json',
    async:true,
    run_id:() => requireString(setup.runId, 'runId'),
    changed_paths:paths,
    providers:[fixture.id === 'dependency-provider' ? 'depfile' : 'static-import'],
    handles,
    query:expected.pattern ?? 'error root',
    changes:replacementChanges.bind(null, taskId, expected, preAttempt, baseline),
    provider:'sourcekit-lsp',
    cursor,
  };
}

export function materializeRequestContract({ taskId, workspaceRoot, preAttemptManifest, baselineManifest, setupEvidence, suite, catalog, execution }) {
  const root = path.resolve(workspaceRoot);
  const setupKeys = new Set(['schema','taskId','workspaceRoot','preStateDigest','checkpoint','cursor','runId','handles']);
  if (setupEvidence?.schema !== 'aishell.benchmark-setup-evidence.v1' || setupEvidence.taskId !== taskId
    || setupEvidence.workspaceRoot !== root || setupEvidence.preStateDigest !== preAttemptManifest.digest
    || !/^[a-f0-9]{64}$/u.test(setupEvidence.preStateDigest)
    || Object.keys(setupEvidence).some((key) => !setupKeys.has(key))) {
    throw new Error(`invalid setup evidence: ${taskId}`);
  }
  const task = suite.tasks.find(({id}) => id === taskId);
  const fixture = catalog.fixtures.find(({id}) => id === task?.fixture);
  const scenario = fixture?.scenarios[task?.scenario];
  if (!task || !fixture || !scenario) throw new Error(`unknown task fixture: ${taskId}`);
  const values = requestValues({taskId, fixture, scenario, expected:scenario.oracle, root,
    preAttempt:preAttemptManifest, baseline:baselineManifest, setup:setupEvidence});
  const requiredCalls = Object.entries(execution.candidateRequiredActionsByTask[taskId]).map(([tool, action]) => {
    const templateId = execution.candidateRequestTemplateByTask[taskId][tool];
    const fields = execution.requestTemplates[templateId];
    const requestSubset = Object.fromEntries(fields.map((field) => {
      const value = field === 'action' ? action : values[field];
      const materialized = typeof value === 'function' ? value() : value;
      if (materialized === undefined || materialized === null || materialized === '' || (Array.isArray(materialized) && materialized.length === 0)) {
        throw new Error(`request value unavailable: ${taskId}.${tool}.${field}`);
      }
      return [field, materialized];
    }));
    return {tool, action, templateId, requestSubset};
  });
  return {schema:'aishell.capability-request-contract.v1', taskId, workspaceRoot:root,
    preStateDigest:preAttemptManifest.digest, requiredCalls};
}
