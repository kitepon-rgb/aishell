#!/usr/bin/env node

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { evaluateAttempt } from './evaluate-capability-oracle.mjs';
import { observeAttempt } from './observe-capability-attempt.mjs';
import { captureManifest } from './capture-workspace-manifest.mjs';
import { materializeRequestContract } from './materialize-capability-request.mjs';

const root = await mkdtemp(path.join(tmpdir(), 'aishell-observer-'));
const workspace = path.join(root, 'workspace');
await mkdir(path.join(workspace, 'src'), {recursive:true});
const files = Object.fromEntries(['process','telemetry','result','trace','toolTrace','agentReport','preAttempt','setupEvidence','requestContract'].map((name) => [name, path.join(root, `${name}.json`)]));
const execution = JSON.parse(await (await import('node:fs/promises')).readFile(new URL('./representative-execution-contracts.v1.json', import.meta.url)));
const suite = JSON.parse(await (await import('node:fs/promises')).readFile(new URL('./representative-suite.v1.json', import.meta.url)));
const catalog = JSON.parse(await (await import('node:fs/promises')).readFile(new URL('./capability-fixtures.v1.json', import.meta.url)));
const artifactStore = path.join(root, 'artifacts');

async function writeJSON(file, value) { await writeFile(file, JSON.stringify(value)); }
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
function rawResult(taskId, tool, assertions, overrides) {
  const exempt = new Set(execution.toolResultProjection.exemptKeys);
  const special = new Set(Object.keys(execution.toolResultProjection.specialKeys));
  const result = {schemaVersion:execution.candidateResultSchemaByTool[tool]};
  for (const [key, value] of Object.entries(assertions)) if (!exempt.has(key) && !special.has(key)) result[key] = value;
  if (assertions.mustContainFiles) result.entries = assertions.mustContainFiles.map((path) => ({path}));
  if (assertions.changedPaths) result.changes = assertions.changedPaths.map((path) => ({path,kind:'modified'}));
  if (assertions.renames) result.changes = assertions.renames.map(([previousPath,path]) => ({previousPath,path,kind:'renamed'}));
  if (assertions.dirty !== undefined) result.gitStatusState = assertions.dirty ? 'dirty' : 'clean';
  if (assertions.apply) result.appliedChanges = assertions.apply;
  if (assertions.matchRuns) result.matches = assertions.matchRuns.map((runId) => ({runId}));
  if (assertions.pattern) result.query = assertions.pattern;
  if (assertions.added || assertions.removed) result.comparison = {added:assertions.added ?? [],removed:assertions.removed ?? []};
  if (assertions.rawEvidenceRetained) result.artifacts = [{handle:'art_one'},{handle:'art_two'}];
  if (assertions.deduplicated !== undefined) result.matches = (assertions.matchedPaths ?? []).map((path) => ({path}));
  if (assertions.provenanceRequired !== undefined) result.provenance = overrides.provenance;
  if (assertions.budgeted !== undefined) Object.assign(result, {returnedBytes:1024,byteBudget:2048});
  if (taskId.startsWith('async-process-') && tool === 'run_check') result.runId = 'run_fixture';
  return {...result,...overrides};
}
function acceptedEvent(taskId, tool, action, request, preStateDigest, assertions, overrides) {
  const expectedError = execution.candidateExpectedErrorByTask[taskId];
  const result = expectedError
    ? {schemaVersion:'aishell.error.v1',error:{code:expectedError}}
    : rawResult(taskId, tool, assertions, overrides);
  return {provider:'aishell',tool,action,status:expectedError ? 'failed' : 'succeeded',isError:Boolean(expectedError),
    metadata:{preStateDigest},request,result,resultDigest:createHash('sha256').update(canonical(result)).digest('hex')};
}
async function evaluate(taskId, extras = {}, resultOverrides = {}) {
  const task = suite.tasks.find(({id}) => id === taskId);
  const fixture = catalog.fixtures.find(({id}) => id === task.fixture);
  const internal = new Set(suite.metrics.internalTelemetryKeys);
  const assertions = Object.fromEntries(Object.entries(fixture.scenarios[task.scenario].oracle).filter(([key]) => !internal.has(key)));
  await writeJSON(files.agentReport, {schema:'aishell.agent-benchmark-report.v1',taskId,
    assertions:extras.agentAssertions ?? assertions});
  const preAttemptFile = extras.preAttemptFile ?? files.preAttempt;
  if (!extras.preAttemptFile) await writeJSON(preAttemptFile, await captureManifest(workspace));
  const preAttempt = JSON.parse(await readFile(preAttemptFile, 'utf8'));
  const setupEvidence = {schema:'aishell.benchmark-setup-evidence.v1', taskId, workspaceRoot:path.resolve(workspace),
    preStateDigest:preAttempt.digest, checkpoint:'chk_fixture', cursor:'ws2:test-root:test-exclusion:test-generation:0',
    runId:'run_fixture', handles:['art_one','art_two'], ...extras.setupFields};
  await writeJSON(files.setupEvidence, setupEvidence);
  const baselineManifest = extras.baselineFile ? JSON.parse(await readFile(extras.baselineFile, 'utf8')) : null;
  const requestContract = materializeRequestContract({taskId, workspaceRoot:workspace, preAttemptManifest:preAttempt,
    baselineManifest, setupEvidence, suite, catalog, execution});
  const requiredCalls = requestContract.requiredCalls;
  await writeJSON(files.requestContract, requestContract);
  await writeJSON(files.toolTrace, {events:requiredCalls.map(({tool,action,requestSubset}) =>
    acceptedEvent(taskId, tool, action, requestSubset, preAttempt.digest, assertions, resultOverrides))});
  const actual = await observeAttempt({taskId,armId:'candidate',workspace,processFile:files.process,
    telemetryFile:files.telemetry,resultFile:files.result,traceFile:files.trace,toolTraceFile:files.toolTrace,agentReportFile:files.agentReport,
    preAttemptFile,setupEvidenceFile:files.setupEvidence,requestContractFile:files.requestContract,...extras});
  return evaluateAttempt({taskId,armId:'candidate',actual});
}

try {
  await writeJSON(files.process, {agentExitCode:0,agentTimedOut:false});

  await writeFile(path.join(workspace, 'src/a.txt'), 'A1\n');
  await writeFile(path.join(workspace, 'src/b.txt'), 'B1\n');
  const applyPreAttempt = path.join(root, 'apply-pre-attempt.json');
  await writeJSON(applyPreAttempt, await captureManifest(workspace));
  await writeFile(path.join(workspace, 'src/a.txt'), 'A2\n');
  await writeFile(path.join(workspace, 'src/b.txt'), 'B2\n');
  await writeJSON(files.telemetry, {partialWrites:0});
  assert.equal((await evaluate('change-set-atomic-success', {preAttemptFile:applyPreAttempt})).solved, true);
  await writeFile(path.join(workspace, 'src/b.txt'), 'wrong\n');
  assert.equal((await evaluate('change-set-atomic-success', {preAttemptFile:applyPreAttempt})).solved, false);

  await writeFile(path.join(workspace, 'run-1.log'), 'warning A\nerror root\n');
  await writeFile(path.join(workspace, 'run-2.log'), 'warning B\nerror root\n');
  await mkdir(artifactStore, {recursive:true});
  const first = Buffer.from('warning A\nerror root\n');
  const second = Buffer.from('warning B\nerror root\n');
  await writeFile(path.join(artifactStore, 'a.log'), first);
  await writeFile(path.join(artifactStore, 'b.log'), second);
  await writeJSON(path.join(artifactStore, 'manifest.json'), {schema:'aishell.retained-artifact-manifest.v1',artifacts:[
    {runId:'run-1',handle:'art_one',file:'a.log',sha256:createHash('sha256').update(first).digest('hex')},
    {runId:'run-2',handle:'art_two',file:'b.log',sha256:createHash('sha256').update(second).digest('hex')},
  ]});
  assert.equal((await evaluate('artifact-query-history-diff', {artifactStore})).solved, true);
  const crossRun = await evaluate('artifact-query-cross-run-search', {
    artifactStore,
    setupFields: {artifactRunAliases:{RUN_A:'run-1',RUN_B:'run-2'}},
    agentAssertions:{matchRuns:['RUN_A','RUN_B'],pattern:'error root'},
  });
  assert.equal(crossRun.solved, true, JSON.stringify(crossRun));
  await writeFile(path.join(artifactStore, 'b.log'), 'tampered\n');
  await assert.rejects(() => evaluate('artifact-query-history-diff', {artifactStore}), /digest mismatch/u);

  await writeJSON(files.trace, {indexCursor:'old',currentCursor:'new'});
  await writeJSON(files.telemetry, {silentLexicalFallbacks:0});
  assert.equal((await evaluate('semantic-context-stale-after-edit')).solved, true);
  await writeJSON(files.trace, {indexCursor:'same',currentCursor:'same'});
  assert.equal((await evaluate('semantic-context-stale-after-edit')).solved, false);

  assert.equal((await evaluate('change-impact-direct-dependent', {}, {provenance:'static-import'})).solved, true);
  assert.equal((await evaluate('change-impact-direct-dependent', {}, {provenance:''})).solved, false);
  await assert.rejects(() => evaluate('change-impact-direct-dependent', {agentAssertions:{}}, {provenance:'static-import'}),
    /invalid agent report/u, 'missing functional assertions must still fail closed');
  await writeJSON(files.telemetry, {secondExecutionCount:0,cacheHit:true,falseFresh:0});
  await evaluate('freshness-cache-repeat-check', {agentAssertions:{cacheState:'hit',processesStarted:0,terminalState:'passed'}});

  await writeJSON(files.process, {agentExitCode:0,agentTimedOut:false,firstDiagnostic:'first failure',terminalExitCode:1});
  assert.equal((await evaluate('async-process-first-useful-result')).solved, true);
  await writeJSON(files.process, {agentExitCode:0,agentTimedOut:false,firstDiagnostic:'late failure',terminalExitCode:1});
  assert.equal((await evaluate('async-process-first-useful-result')).solved, false);

  await writeJSON(files.process, {agentExitCode:0,agentTimedOut:false});
  await evaluate('change-impact-direct-dependent', {}, {provenance:'static-import'});
  const impactRequest = JSON.parse(await readFile(files.requestContract, 'utf8')).requiredCalls[0].requestSubset;
  await writeJSON(files.toolTrace, {events:[]});
  const missingCapability = await observeAttempt({taskId:'change-impact-direct-dependent',armId:'candidate',workspace,
    processFile:files.process,toolTraceFile:files.toolTrace,agentReportFile:files.agentReport,
    preAttemptFile:files.preAttempt,setupEvidenceFile:files.setupEvidence,requestContractFile:files.requestContract});
  assert.equal((await evaluateAttempt({taskId:'change-impact-direct-dependent',armId:'candidate',actual:missingCapability})).solved, false);

  await writeJSON(files.toolTrace, {events:[{...acceptedEvent('change-impact-direct-dependent','change_impact','analyze',impactRequest,
    JSON.parse(await readFile(files.preAttempt,'utf8')).digest,{impactedPaths:['src/b.mjs','test/b.test.mjs'],provenanceRequired:true},{provenance:'static-import'}),status:'failed',isError:true}]});
  const failedCapability = await observeAttempt({taskId:'change-impact-direct-dependent',armId:'candidate',workspace,
    processFile:files.process,toolTraceFile:files.toolTrace,agentReportFile:files.agentReport,
    preAttemptFile:files.preAttempt,setupEvidenceFile:files.setupEvidence,requestContractFile:files.requestContract});
  assert.equal((await evaluateAttempt({taskId:'change-impact-direct-dependent',armId:'candidate',actual:failedCapability})).solved, false);

  await writeJSON(files.toolTrace, {events:[acceptedEvent('change-impact-direct-dependent','change_impact','analyze',
    {...impactRequest,changed_paths:['wrong']},JSON.parse(await readFile(files.preAttempt,'utf8')).digest,
    {impactedPaths:['src/b.mjs','test/b.test.mjs'],provenanceRequired:true},{provenance:'static-import'})]});
  const wrongRequest = await observeAttempt({taskId:'change-impact-direct-dependent',armId:'candidate',workspace,
    processFile:files.process,toolTraceFile:files.toolTrace,agentReportFile:files.agentReport,
    preAttemptFile:files.preAttempt,setupEvidenceFile:files.setupEvidence,requestContractFile:files.requestContract});
  assert.equal((await evaluateAttempt({taskId:'change-impact-direct-dependent',armId:'candidate',actual:wrongRequest})).solved, false);

  await writeJSON(files.toolTrace, {events:[acceptedEvent('change-impact-direct-dependent','change_impact','analyze',impactRequest,
    JSON.parse(await readFile(files.preAttempt,'utf8')).digest,{impactedPaths:['src/b.mjs','test/b.test.mjs'],provenanceRequired:true},{provenance:'static-import'})]});
  await assert.rejects(() => observeAttempt({taskId:'change-impact-direct-dependent',armId:'candidate',workspace,
    processFile:files.process,toolTraceFile:files.toolTrace,preAttemptFile:files.preAttempt,
    setupEvidenceFile:files.setupEvidence,requestContractFile:files.requestContract}), /invalid agent report/u);

  await assert.rejects(() => observeAttempt({taskId:'workspace-wait-external-edit',armId:'candidate',workspace,
    processFile:files.process,toolTraceFile:files.toolTrace}), /baseline manifest required/u);
  await assert.rejects(() => observeAttempt({taskId:'workspace-wait-external-edit',armId:'candidate',workspace,
    baselineFile:path.join(root,'missing.json'),processFile:files.process,toolTraceFile:files.toolTrace}), /ENOENT/u);

  await writeFile(path.join(workspace, 'src/state.txt'), 'one\n');
  const baselineFile = path.join(root, 'baseline.json');
  await writeJSON(baselineFile, await captureManifest(workspace));
  await writeFile(path.join(workspace, 'src/state.txt'), 'two\n');
  await writeJSON(files.telemetry, {pollLoops:0});
  assert.equal((await evaluate('workspace-wait-external-edit', {baselineFile})).solved, true);

  await writeFile(path.join(workspace, 'src/needle.mjs'), 'export const needle = 1;\n');
  await writeJSON(files.telemetry, {silentTruncations:0});
  await writeJSON(files.trace, {pages:[],expectedItems:[]});
  assert.equal((await evaluate('batch-context-shared-budget')).solved, false, 'trace自己申告だけでは完全扱いしない');
  await writeJSON(files.trace, {pages:[{items:['src/needle.mjs']}],expectedItems:[]});
  assert.equal((await evaluate('batch-context-shared-budget')).solved, true, 'workspaceから独立算出したground truthへ一致する');

  await writeJSON(files.telemetry, {silentFullScans:0});
  assert.equal((await evaluate('workspace-wait-event-gap')).solved, true, '期待typed errorをaccepted outcomeとして扱う');
  await writeJSON(files.telemetry, {silentTextFallbacks:0});
  const diagnostic = await evaluate('diagnostic-adapter-known-format', {
    agentAssertions:{
      diagnostics:[{path:'src/a.swift',line:3,message:'boom',adapter:'sarif',severity:'error'}],
      provenance:'sarif',
    },
  }, {
    diagnostics:[{path:'src/a.swift',line:3,message:'boom',adapter:'sarif',severity:'error'}],
    provenance:'sarif',
  });
  assert.equal(diagnostic.solved, true, JSON.stringify(diagnostic));
  await writeFile(path.join(workspace, 'src/state.txt'), 'one\n');
  const bilingualBaselineFile = path.join(root, 'bilingual-baseline.json');
  await writeJSON(bilingualBaselineFile, await captureManifest(workspace));
  await writeFile(path.join(workspace, 'src/state.txt'), 'two\n');
  await writeJSON(files.telemetry, {pollLoops:0});
  const bilingualEnglish = await evaluate('bilingual-workflow-english', {
    baselineFile:bilingualBaselineFile,
    agentAssertions:{changedPaths:['src/state.txt'],language:'English',requiredCapability:'workspace_wait'},
  });
  assert.equal(bilingualEnglish.solved, true, JSON.stringify(bilingualEnglish));
} finally {
  await rm(root, {recursive:true,force:true});
}

process.stdout.write('{"schema":"aishell.capability_observer_self_test.v1","sources":7,"positive_cases":9,"negative_cases":12,"status":"valid"}\n');
