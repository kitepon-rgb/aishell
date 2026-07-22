#!/usr/bin/env node

import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { captureManifest } from './capture-workspace-manifest.mjs';
import { evaluateAttempt } from './evaluate-capability-oracle.mjs';
import { materializeRequestContract } from './materialize-capability-request.mjs';
import { observeAttempt } from './observe-capability-attempt.mjs';
import {
  captureTrustedSetup,
  collectAttemptEvidence,
  exchangeMCP,
  observeProviderModel,
  runProcess,
  runSetupStep,
  selectCompatibleCandidateRoot,
} from './phase3-local-callbacks.mjs';
import { extractProviderUsageFromSSETrace, prepareCandidateRequests } from './phase3-representative-runner.mjs';
import { canonicalJSONBytes, sha256Hex } from './production-v2-benchmark-adapter.mjs';

const root = await mkdtemp(path.join(tmpdir(), 'aishell-phase3-local-callbacks-'));

const incompatibleAnalyze = { tool: 'change_impact', isError: false, request: { operation: 'analyze' } };
const failedRecommend = { tool: 'change_impact', isError: true, request: { operation: 'recommend' } };
assert.equal(selectCompatibleCandidateRoot(
  [failedRecommend, incompatibleAnalyze], { tool: 'change_impact', action: 'recommend' },
  ({ request }) => request.operation === 'recommend',
), null);
const compatibleRecommend = { tool: 'change_impact', isError: false,
  request: { operation: 'recommend' }, result: { operation: 'recommend' } };
assert.equal(selectCompatibleCandidateRoot(
  [incompatibleAnalyze, compatibleRecommend], { tool: 'change_impact', action: 'recommend' },
  ({ request }) => request.operation === 'recommend',
), compatibleRecommend);
const semanticallyMatchingRecommend = { tool: 'change_impact', isError: false,
  request: { operation: 'recommend', extra: true }, result: { operation: 'recommend' } };
assert.equal(selectCompatibleCandidateRoot(
  [incompatibleAnalyze, semanticallyMatchingRecommend], { tool: 'change_impact', action: 'recommend' },
  () => false,
), semanticallyMatchingRecommend);
const successfulRunCheck = { tool: 'run_check', isError: false,
  request: { cache: 'only' }, result: { schemaVersion: 'aishell.run-check.v2' } };
assert.equal(selectCompatibleCandidateRoot(
  [successfulRunCheck], { tool: 'run_check', action: 'execute' }, () => false,
), successfulRunCheck);
const workspace = path.join(root, 'workspace');
const stateDirectory = path.join(root, 'state');
await mkdir(workspace);
await mkdir(stateDirectory);
await mkdir(path.join(workspace, 'src'));
await mkdir(path.join(workspace, 'test'));
await writeFile(path.join(workspace, 'check.mjs'), "import { value } from './src/value.mjs'; if(value!==1)process.exit(1);\n");
await writeFile(path.join(workspace, 'src/value.mjs'), 'export const value = 1;\n');

const child = path.join(root, 'child.mjs');
await writeFile(child, "process.stdout.write('stdout-bytes');process.stderr.write('stderr-bytes');\n");
const processResult = await runProcess(process.execPath, [child], {
  cwd: workspace, env: process.env, timeoutMilliseconds: 5_000,
});
assert.equal(processResult.exitCode, 0);
assert.equal(processResult.timedOut, false);
assert.equal(processResult.stdout.toString(), 'stdout-bytes');
assert.equal(processResult.stderr.toString(), 'stderr-bytes');

const timeoutChild = path.join(root, 'timeout.mjs');
await writeFile(timeoutChild, 'setTimeout(()=>{},10_000);\n');
const timeoutResult = await runProcess(process.execPath, [timeoutChild], {
  cwd: workspace, env: process.env, timeoutMilliseconds: 20,
});
assert.equal(timeoutResult.timedOut, true);
assert.notEqual(timeoutResult.exitCode, 0);

const mcpBinary = path.join(root, 'fake-aishell.mjs');
const profileDigest = 'a'.repeat(64);
await writeFile(mcpBinary, `#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
const digest=(value)=>createHash('sha256').update(value).digest('hex');
const tuple=(values)=>values.map((value)=>Buffer.byteLength(value)+':'+value).join('');
const artifact=(handle,sha)=>({handle,kind:'process-log',sizeBytes:0,lineCount:0,sha256:sha,createdAt:'2098-01-01T00:00:00Z',expiresAt:'2099-01-01T00:00:00Z',producer:'fake'});
const node=realpathSync(process.execPath);const nodeStat=lstatSync(node);const nodeSHA=digest(readFileSync(node));
let input='';for await(const chunk of process.stdin)input+=chunk;
const lines=input.split('\\n').filter(Boolean).map(JSON.parse);
for(const message of lines){
 if(message.id===1)console.log(JSON.stringify({jsonrpc:'2.0',id:1,result:{protocolVersion:'2025-11-25',capabilities:{},serverInfo:{name:'fake',version:'1'}}}));
 if(message.method==='tools/call'){
  const name=message.params.name;let structured;
  if(process.env.AISHELL_CAPABILITY_SET!=='expanded-v1'&&name==='workspace_snapshot'&&message.params.arguments.project_profile)process.exit(3);
  if(name==='workspace_snapshot'){
   const bad=process.env.FAKE_BAD_CHECK;const contract=bad==='missing-contract'?undefined:{schemaVersion:'aishell.project-profile-check-input.v1',completeness:'complete',provider:'fake',providerVersion:'1',includedRoots:bad==='wrong-inputs'?['check.mjs']:['check.mjs','src/value.mjs'],trackedPaths:[],effectCompleteness:'project_root_closed',reason:null};
   const check={checkId:'test',kind:'test',label:'fixture',executable:bad==='true-executable'?'/bin/true':node,arguments:['check.mjs'],workingDirectory:bad==='wrong-cwd'?realpathSync('..'):realpathSync(process.cwd()),environmentKeys:[],provenance:{kind:'fake',path:'check.mjs',contentSHA256:null,producerVersion:'1',confidence:'exact'},...(contract?{inputContract:contract}:{})};
   structured={schemaVersion:'aishell.workspace-snapshot.v2',root:process.cwd(),cursor:'ws2:root:exclude:generation:0',projectProfiles:process.env.FAKE_NO_PROFILE==='1'?[]:[{projectId:'fixture-project',profileDigest:'${profileDigest}',projectRootIdentity:'1:2',checks:[check],toolchains:[{name:'node',executable:node,identity:String(nodeStat.dev)+':'+String(nodeStat.ino),sha256:nodeSHA,versionArguments:['--version'],version:'fake',exitStatus:0,evidenceSHA256:'${'9'.repeat(64)}',evidenceHandle:'art_node',evidenceExpiresAt:'2099-01-01T00:00:00Z'}]}],projectProfileHasMore:false};
  }
  else if(name==='run_check'&&message.params.arguments.schema==='aishell.run-check.v2'){
   const mode=process.env.FAKE_WARM_MODE??'miss';const outSHA='${'1'.repeat(64)}';const errSHA='${'2'.repeat(64)}';
   structured={schemaVersion:'aishell.run-check.v2',planDigest:'${'b'.repeat(64)}',selectionDigest:'${'c'.repeat(64)}',requestedCheckIDs:['test'],plannedCheckIDs:['test'],cacheState:mode==='hit'?'hit':mode==='ineligible'?'ineligible':'miss_executed',processesStarted:mode==='zero'||mode==='hit'?0:1,publications:mode==='hit'||mode==='ineligible'?0:1,steps:mode==='hit'?[]:[{stepID:'test',terminalState:mode==='failed'?'failed':'passed',sourceRunID:'run-1',stdoutArtifactSHA256:outSHA,stderrArtifactSHA256:errSHA,artifacts:[artifact('art_out',outSHA),artifact('art_err',errSHA)],skippedBecauseDependencyFailed:false}],lookupEvidence:[{stepID:'test',status:mode==='hit'?'hit':mode==='ineligible'?'ineligible':'miss',ineligibilityReason:mode==='ineligible'?'binding_incomplete':null}]};
  }
  else if(name==='run_check'){
   const failed=process.env.FAKE_LEGACY_FAILED==='1';structured={schemaVersion:'aishell.run-check.v1',requestID:'request-1',status:failed?'failed':'passed',summary:failed?'failed':'success',primaryDiagnostic:null,exitCode:failed?1:0,timedOut:false,durationMilliseconds:1,stdoutArtifact:artifact('legacy_out','${'3'.repeat(64)}'),stderrArtifact:artifact('legacy_err','${'4'.repeat(64)}')};
  }
  else if(name==='change_impact'){
   const cursor='ws2:root:exclude:generation:0';const partial=process.env.FAKE_IMPACT_PARTIAL==='1';const bad=process.env.FAKE_IMPACT_BAD;const rootStat=lstatSync(process.cwd());const bSHA=digest(readFileSync('src/b.mjs'));const testSHA=digest(readFileSync('test/b.test.mjs'));const aSHA=message.params.arguments.changed_paths[0].content_sha256;
   let candidates=[
    {kind:'candidate',itemID:'candidate-direct',candidateID:'candidate-1',category:'dependencies',subject:{kind:'path',path:bad==='subject'?'src/wrong.mjs':'src/b.mjs'}},
    {kind:'candidate',itemID:'candidate-test',candidateID:'candidate-2',category:'related_tests',subject:{kind:'test',path:bad==='transitive-subject'?'test/wrong.test.mjs':'test/b.test.mjs'}}];
   let proofs=[
    {kind:'evidence',itemID:'evidence-direct',providerID:'static-import',subject:{kind:'path',path:bad==='subject'?'src/wrong.mjs':'src/b.mjs'},evidenceID:'evidence-1',inputIdentity:tuple(['input_path','src/a.mjs','0',aSHA]),relation:bad==='relation'?'lexical_reference':'declared_dependency',locator:{path:'src/b.mjs',contentSHA256:bad==='sha'?'${'7'.repeat(64)}':bSHA,startOffset:18,endOffset:27,edgeID:tuple(['src/b.mjs','src/a.mjs'])},evidenceStrength:'declared_edge',summary:'direct static import'},
    {kind:'evidence',itemID:'evidence-test',providerID:'static-import',subject:{kind:'test',path:bad==='transitive-subject'?'test/wrong.test.mjs':'test/b.test.mjs'},evidenceID:'evidence-2',inputIdentity:tuple(['input_path','src/a.mjs','0',aSHA]),relation:bad==='transitive-relation'?'lexical_reference':'declared_dependency',locator:{path:'test/b.test.mjs',contentSHA256:testSHA,startOffset:7,endOffset:21,edgeID:tuple(['test/b.test.mjs','src/b.mjs'])},evidenceStrength:'declared_edge',summary:'transitive static import'}];
   let links=[
    {kind:'candidate_evidence',itemID:'edge-direct',candidateID:'candidate-1',evidenceID:'evidence-1'},
    {kind:'candidate_evidence',itemID:'edge-test',candidateID:'candidate-2',evidenceID:'evidence-2'}];
   if(bad==='missing'){candidates=candidates.slice(0,1);proofs=proofs.slice(0,1);links=links.slice(0,1)}
   if(bad==='extra'){candidates.push({...candidates[0],itemID:'candidate-extra',candidateID:'candidate-3',subject:{kind:'path',path:'src/extra.mjs'}});proofs.push({...proofs[0],itemID:'evidence-extra',evidenceID:'evidence-3',subject:{kind:'path',path:'src/extra.mjs'}});links.push({kind:'candidate_evidence',itemID:'edge-extra',candidateID:'candidate-3',evidenceID:'evidence-3'})}
   const items=partial?[]:[
    {kind:'input_path',itemID:'input',changedPath:{path:'src/a.mjs',contentSHA256:aSHA,expectedAbsent:false}},
    {kind:'required_provider',itemID:'required',providerID:'static-import'},
    {kind:'freshness_binding',itemID:'binding',freshnessBinding:{role:'analysis',path:'src/b.mjs',contentSHA256:bSHA,expectedAbsent:false}},
    {kind:'provider_report',itemID:'report-filesystem',providerReport:{descriptor:{providerID:'aishell.filesystem-impact',kind:'lexical_search',version:'1'},status:bad==='filesystem-report'?'stale':'fresh',inputDigest:'${'8'.repeat(64)}',observedAtCursor:cursor,reasonCode:null,nextAction:null}},
    {kind:'provider_report',itemID:'report',providerReport:{descriptor:{providerID:'static-import',kind:'lexical_search',version:'1'},status:'fresh',inputDigest:'${'5'.repeat(64)}',observedAtCursor:cursor,reasonCode:null,nextAction:null}},
    ...candidates,...proofs,...links];
   structured={schemaVersion:'aishell.change-impact.v2',operation:'analyze',coverage:partial?'partial':'complete',freshness:{rootIdentity:String(rootStat.dev)+':'+String(rootStat.ino),workspaceGeneration:'0',inputCursor:cursor,observedCursor:cursor,bindingDigest:'${'6'.repeat(64)}',bindingCount:4},counts:{references:0,dependencies:partial?0:1,relatedTests:partial?0:1,buildTargets:0},items,returnedBytes:partial?0:1,omittedBytes:0,hasMore:false,continuation:null,artifact:{...artifact('art_impact','${sha256Hex(Buffer.alloc(0))}'),kind:'change-impact-jsonl',sizeBytes:partial?0:1}};
  }
  else process.exit(2);
  console.log(JSON.stringify({jsonrpc:'2.0',id:message.id,result:{isError:false,structuredContent:structured,content:[]}}));
 }
}
`);
await chmod(mcpBinary, 0o755);
const armBinding = { aishellBinaryDigest: sha256Hex(await readFile(mcpBinary)) };

const previous = Object.fromEntries([
  'AISHELL_PHASE3_CANDIDATE_BINARY', 'AISHELL_PHASE3_CURRENT_BINARY',
  'AISHELL_PHASE3_MCP_TIMEOUT_MS', 'AISHELL_PHASE3_SETUP_TIMEOUT_MS',
].map((key) => [key, process.env[key]]));
process.env.AISHELL_PHASE3_CANDIDATE_BINARY = mcpBinary;
process.env.AISHELL_PHASE3_CURRENT_BINARY = mcpBinary;
process.env.AISHELL_PHASE3_MCP_TIMEOUT_MS = '5000';
process.env.AISHELL_PHASE3_SETUP_TIMEOUT_MS = '5000';

const requestBytes = Buffer.from(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })}\n`);
const exchange = await exchangeMCP({
  binary: mcpBinary, profile: 'expanded-v1', stateDirectory, workspace, requestBytes,
});
const exchangeMessages = exchange.toString('utf8').trim().split('\n').map(JSON.parse);
assert.equal(exchangeMessages[0].result.protocolVersion, '2025-11-25');

const nativeAttempt = { taskID: 'freshness-cache-repeat-check', arm: 'native' };
const nativeSetup = await runSetupStep({
  attempt: nativeAttempt, workspace, stateDirectory,
  step: 'execute the check once and retain its freshness inputs',
});
assert.equal(nativeSetup.processCount, 1);

const candidateAttempt = {
  attemptID: 'phase3-local-candidate', sequence: 1,
  taskID: 'freshness-cache-repeat-check', arm: 'candidate', repetition: 1,
};
const candidateSetup = await runSetupStep({
  attempt: candidateAttempt, armBinding, workspace, stateDirectory,
  step: 'execute the check once and retain its freshness inputs',
});
assert.equal(candidateSetup.processCount, 1);
assert.equal(candidateSetup.structuredResult.cacheState, 'miss_executed');

const currentSetup = await runSetupStep({
  attempt: { ...candidateAttempt, arm: 'current-aishell-0.3.3' }, armBinding, workspace, stateDirectory,
  step: 'execute the check once and retain its freshness inputs',
});
assert.equal(currentSetup.processCount, 1, 'current arm must warm through legacy run_check without project_profile');
assert.equal(currentSetup.structuredResult.status, 'passed');

for (const mode of ['hit', 'zero', 'failed', 'ineligible']) {
  process.env.FAKE_WARM_MODE = mode;
  await assert.rejects(() => runSetupStep({
    attempt: candidateAttempt, armBinding, workspace, stateDirectory,
    step: 'execute the check once and retain its freshness inputs',
  }));
}
delete process.env.FAKE_WARM_MODE;
process.env.FAKE_LEGACY_FAILED = '1';
await assert.rejects(() => runSetupStep({
  attempt: { ...candidateAttempt, arm: 'current-aishell-0.3.3' }, armBinding, workspace, stateDirectory,
  step: 'execute the check once and retain its freshness inputs',
}), /legacy warm run/u);
delete process.env.FAKE_LEGACY_FAILED;
await assert.rejects(() => runSetupStep({
  attempt: candidateAttempt, armBinding: { aishellBinaryDigest: '0'.repeat(64) }, workspace, stateDirectory,
  step: 'execute the check once and retain its freshness inputs',
}), /differs from the measured arm binding/u);

await writeFile(path.join(workspace, 'src/a.mjs'), 'export const a = 1;\n');
await writeFile(path.join(workspace, 'src/b.mjs'), "import { a } from './a.mjs'; export const b = a;\n");
await writeFile(path.join(workspace, 'test/b.test.mjs'), "import '../src/b.mjs';\n");
const indexSetup = await runSetupStep({
  attempt: { ...candidateAttempt, taskID: 'change-impact-direct-dependent' }, armBinding,
  workspace, stateDirectory, step: 'index static imports',
});
assert.equal(indexSetup.processCount, 0);
assert.equal(indexSetup.structuredResult.coverage, 'complete');
process.env.FAKE_IMPACT_PARTIAL = '1';
await assert.rejects(() => runSetupStep({
  attempt: { ...candidateAttempt, taskID: 'change-impact-direct-dependent' }, armBinding,
  workspace, stateDirectory, step: 'index static imports',
}), /complete fresh candidate\/evidence semantics/u);
delete process.env.FAKE_IMPACT_PARTIAL;
for (const mode of ['subject', 'relation', 'sha', 'transitive-subject', 'transitive-relation', 'missing', 'extra', 'filesystem-report']) {
  process.env.FAKE_IMPACT_BAD = mode;
  await assert.rejects(() => runSetupStep({
    attempt: { ...candidateAttempt, taskID: 'change-impact-direct-dependent' }, armBinding,
    workspace, stateDirectory, step: 'index static imports',
  }), /complete fresh candidate\/evidence semantics/u);
}
delete process.env.FAKE_IMPACT_BAD;

const trusted = await captureTrustedSetup({ attempt: candidateAttempt, armBinding, workspace, stateDirectory });
assert.equal(trusted.run_check.profileCheck.projectID, 'fixture-project');
assert.equal(trusted.run_check.profileCheck.profileDigest, profileDigest);
assert.equal(trusted.run_check.profileCheck.checkID, 'test');
process.env.FAKE_NO_PROFILE = '1';
await assert.rejects(() => captureTrustedSetup({ attempt: candidateAttempt, armBinding, workspace, stateDirectory }),
  /no exact production project profile/u);
delete process.env.FAKE_NO_PROFILE;

for (const mode of ['true-executable', 'wrong-cwd', 'missing-contract', 'wrong-inputs']) {
  process.env.FAKE_BAD_CHECK = mode;
  await assert.rejects(() => captureTrustedSetup({ attempt: candidateAttempt, armBinding, workspace, stateDirectory }));
}
delete process.env.FAKE_BAD_CHECK;

const changeTrusted = await captureTrustedSetup({
  attempt: { ...candidateAttempt, taskID: 'change-impact-direct-dependent' }, armBinding, workspace, stateDirectory,
});
assert.equal(changeTrusted.change_impact.root, await (await import('node:fs/promises')).realpath(workspace));
assert.match(changeTrusted.change_impact.rootIdentity, /^\d+:\d+$/u);
assert.equal(changeTrusted.change_impact.pathBindings[0].contentSHA256, sha256Hex(await readFile(path.join(workspace, 'src/a.mjs'))));

const baselineManifest = await captureManifest(workspace);
const preAttemptManifest = baselineManifest;
const benchmarkSetupEvidence = {
  schema: 'aishell.benchmark-setup-evidence.v1', taskId: candidateAttempt.taskID,
  workspaceRoot: workspace, preStateDigest: preAttemptManifest.digest,
};
const prepared = await prepareCandidateRequests({
  taskId: candidateAttempt.taskID, workspaceRoot: workspace, preAttemptManifest, baselineManifest,
  setupEvidence: benchmarkSetupEvidence, trustedProductionSetup: trusted,
});
const productionRequest = prepared.calls[0].productionRequest;
const productionResult = {
  schemaVersion: 'aishell.run-check.v2', planDigest: 'b'.repeat(64), selectionDigest: 'c'.repeat(64),
  requestedCheckIDs: ['test'], plannedCheckIDs: ['test'], cacheState: 'hit', processesStarted: 0,
  publications: 0, steps: [], lookupEvidence: [{ stepID: 'test', status: 'hit', ineligibilityReason: null }],
};
const productionResultBytes = canonicalJSONBytes(productionResult);
const agentEvents = [
  { type: 'item.completed', item: {
    type: 'mcp_tool_call', server: 'aishell', tool: 'run_check', arguments: productionRequest,
    result: productionResult, result_bytes_base64: productionResultBytes.toString('base64'), status: 'completed',
  } },
  { type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } },
];
const collected = await collectAttemptEvidence({
  attempt: candidateAttempt, workspace, stateDirectory, preAttemptManifest, baselineManifest,
  benchmarkSetupEvidence, trustedProductionSetup: trusted, agentEvents,
  finalAgent: { assertions: {} }, execution: { exitCode: 0, timedOut: false },
});
assert.deepEqual(collected.result, { secondExecutionCount: 0, cacheHit: true, falseFresh: 0 });
assert.deepEqual(collected.telemetry, { secondExecutionCount: 0, cacheHit: true, falseFresh: 0 });
assert.equal(Buffer.isBuffer(collected.adapterTraceBytes), true);
assert.equal(collected.toolTrace.events[0].action, 'execute');
assert.deepEqual(collected.toolTrace.events.at(-1), {
  provider: 'aishell', tool: 'run_check', action: 'execute', request: prepared.calls[0].frozenRequest,
  metadata: { preStateDigest: preAttemptManifest.digest }, result: productionResult,
  resultDigest: sha256Hex(productionResultBytes), status: 'succeeded', isError: false,
});
assert.equal(collected.metrics.toolCalls, 1);
const acceptanceDirectory = path.join(root, 'projected-acceptance');
await mkdir(acceptanceDirectory);
const acceptanceFiles = Object.fromEntries(['baseline', 'preAttempt', 'setup', 'request', 'result', 'process',
  'telemetry', 'trace', 'toolTrace', 'agentReport'].map((name) => [name, path.join(acceptanceDirectory, `${name}.json`)]));
const [suite, catalog, executionContracts] = await Promise.all([
  readFile(new URL('representative-suite.v1.json', import.meta.url), 'utf8').then(JSON.parse),
  readFile(new URL('capability-fixtures.v1.json', import.meta.url), 'utf8').then(JSON.parse),
  readFile(new URL('representative-execution-contracts.v1.json', import.meta.url), 'utf8').then(JSON.parse),
]);
const requestContract = materializeRequestContract({
  taskId: candidateAttempt.taskID, workspaceRoot: workspace, preAttemptManifest, baselineManifest,
  setupEvidence: benchmarkSetupEvidence, suite, catalog, execution: executionContracts,
});
const agentReport = { schema: 'aishell.agent-benchmark-report.v1', taskId: candidateAttempt.taskID, assertions: {} };
for (const [file, value] of [
  [acceptanceFiles.baseline, baselineManifest], [acceptanceFiles.preAttempt, preAttemptManifest],
  [acceptanceFiles.setup, benchmarkSetupEvidence], [acceptanceFiles.request, requestContract],
  [acceptanceFiles.result, collected.result],
  [acceptanceFiles.process, { agentExitCode: 0, agentTimedOut: false }],
  [acceptanceFiles.telemetry, collected.telemetry], [acceptanceFiles.trace, collected.trace],
  [acceptanceFiles.toolTrace, collected.toolTrace], [acceptanceFiles.agentReport, agentReport],
]) await writeFile(file, `${JSON.stringify(value)}\n`);
const projectedObservation = await observeAttempt({
  taskId: candidateAttempt.taskID, armId: candidateAttempt.arm, workspace,
  baselineFile: acceptanceFiles.baseline, preAttemptFile: acceptanceFiles.preAttempt,
  setupEvidenceFile: acceptanceFiles.setup, requestContractFile: acceptanceFiles.request,
  resultFile: acceptanceFiles.result, processFile: acceptanceFiles.process,
  artifactStore: collected.artifactStore, telemetryFile: acceptanceFiles.telemetry,
  traceFile: acceptanceFiles.trace, toolTraceFile: acceptanceFiles.toolTrace,
  agentReportFile: acceptanceFiles.agentReport,
});
assert.deepEqual(projectedObservation.capabilityEvidence.acceptedInvocations, ['run_check:execute']);
assert.equal((await evaluateAttempt({ taskId: candidateAttempt.taskID, armId: candidateAttempt.arm,
  actual: projectedObservation })).solved, true);
const exploratoryResult = { schemaVersion: 'aishell.workspace-snapshot.v2', entries: [] };
const expectedMiss = {
  schemaVersion: 'aishell.run-check.v2',
  error: { code: 'RUN_CHECK_CACHE_MISS', processesStarted: 0, lookupEvidence: [] },
};
const exploratoryEvents = [
  { type: 'item.completed', item: {
    type: 'mcp_tool_call', server: 'aishell', tool: 'workspace_snapshot', arguments: { path: '.' },
    result: exploratoryResult, result_bytes_base64: canonicalJSONBytes(exploratoryResult).toString('base64'), status: 'completed',
  } },
  { type: 'item.completed', item: {
    type: 'mcp_tool_call', server: 'aishell', tool: 'run_check', arguments: { ...productionRequest, cache: 'only' },
    result: expectedMiss, result_bytes_base64: canonicalJSONBytes(expectedMiss).toString('base64'), status: 'failed',
  } },
  ...agentEvents,
];
const exploratoryCollected = await collectAttemptEvidence({
  attempt: candidateAttempt, workspace, stateDirectory, preAttemptManifest, baselineManifest,
  benchmarkSetupEvidence, trustedProductionSetup: trusted, agentEvents: exploratoryEvents,
  finalAgent: { assertions: {} }, execution: { exitCode: 0, timedOut: false },
});
assert.deepEqual(exploratoryCollected.result, collected.result);
assert.equal(exploratoryCollected.metrics.toolCalls, 3);
assert.equal(exploratoryCollected.metrics.retries, 1);
const currentCollected = await collectAttemptEvidence({
  attempt: { ...candidateAttempt, arm: 'current-aishell-0.3.3' }, workspace, stateDirectory,
  preAttemptManifest, baselineManifest, benchmarkSetupEvidence, trustedProductionSetup: trusted,
  agentEvents: exploratoryEvents, finalAgent: { assertions: {} }, execution: { exitCode: 0, timedOut: false },
});
assert.deepEqual(currentCollected.toolTrace.events.map(({ tool, action }) => ({ tool, action })), [
  { tool: 'workspace_snapshot', action: 'snapshot' },
  { tool: 'run_check', action: 'execute' },
  { tool: 'run_check', action: 'execute' },
]);
const externalMCPResult = { content: [{ type: 'text', text: '{"resources":[]}' }], structured_content: null };
const externalCollected = await collectAttemptEvidence({
  attempt: { ...candidateAttempt, arm: 'native' }, workspace, stateDirectory,
  preAttemptManifest, baselineManifest, benchmarkSetupEvidence, trustedProductionSetup: trusted,
  agentEvents: [{ type: 'item.completed', item: {
    id: 'external-1', type: 'mcp_tool_call', server: 'codex', tool: 'list_mcp_resources', arguments: {},
    result: externalMCPResult, error: null, status: 'completed',
  } }], finalAgent: { assertions: {} }, execution: { exitCode: 0, timedOut: false },
});
assert.deepEqual(externalCollected.toolTrace.events.map(({ provider, tool, action, status }) => ({ provider, tool, action, status })), [{
  provider: 'codex', tool: 'list_mcp_resources', action: 'list_mcp_resources', status: 'succeeded',
}]);
assert.equal(externalCollected.metrics.toolCalls, 1);
const unknownLegacyResult = { schemaVersion: 'unknown.v1' };
await assert.rejects(() => collectAttemptEvidence({
  attempt: { ...candidateAttempt, arm: 'native' }, workspace, stateDirectory,
  preAttemptManifest, baselineManifest, benchmarkSetupEvidence, trustedProductionSetup: trusted,
  agentEvents: [{ type: 'item.completed', item: {
    type: 'mcp_tool_call', server: 'aishell', tool: 'unknown_tool', arguments: {},
    result: unknownLegacyResult, result_bytes_base64: canonicalJSONBytes(unknownLegacyResult).toString('base64'),
    status: 'completed',
  } }], finalAgent: { assertions: {} }, execution: { exitCode: 0, timedOut: false },
}), /legacy\/local tool action is unavailable: unknown_tool/u);
const mcpWireDirectory = path.join(root, 'mcp-wire');
await mkdir(mcpWireDirectory);
await writeFile(path.join(mcpWireDirectory, 'requests.bin'), Buffer.from(`${JSON.stringify({
  jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'run_check', arguments: productionRequest },
})}\n`));
await writeFile(path.join(mcpWireDirectory, 'responses.bin'), Buffer.from(
  `{"jsonrpc":"2.0","id":7,"result":{"content":[],"structuredContent":${productionResultBytes.toString('utf8')},"isError":false}}\n`,
));
const wireAgentEvents = [
  { type: 'item.completed', item: {
    type: 'mcp_tool_call', server: 'aishell', tool: 'run_check', arguments: productionRequest,
    result: { content: [], structured_content: productionResult }, error: null, status: 'completed', id: '7',
  } },
  { type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } },
];
const wireCollected = await collectAttemptEvidence({
  attempt: candidateAttempt, workspace, stateDirectory, mcpWireDirectory, preAttemptManifest, baselineManifest,
  benchmarkSetupEvidence, trustedProductionSetup: trusted, agentEvents: wireAgentEvents,
  finalAgent: { assertions: {} }, execution: { exitCode: 0, timedOut: false },
});
const rejectedBeforeTransportEvents = [
  { type: 'item.completed', item: {
    id: 'rejected-1', type: 'mcp_tool_call', server: 'aishell', tool: 'workspace_snapshot', arguments: { path: '.' },
    result: null, error: { message: 'rejected before MCP transport' }, status: 'failed',
  } },
  ...wireAgentEvents,
];
const rejectedBeforeTransportCollected = await collectAttemptEvidence({
  attempt: { ...candidateAttempt, arm: 'current-aishell-0.3.3' }, workspace, stateDirectory,
  mcpWireDirectory, preAttemptManifest, baselineManifest, benchmarkSetupEvidence,
  trustedProductionSetup: trusted, agentEvents: rejectedBeforeTransportEvents,
  finalAgent: { assertions: {} }, execution: { exitCode: 0, timedOut: false },
});
assert.deepEqual(rejectedBeforeTransportCollected.toolTrace.events.map(({ tool, action, status }) => ({ tool, action, status })), [
  { tool: 'workspace_snapshot', action: 'snapshot', status: 'failed' },
  { tool: 'run_check', action: 'execute', status: 'succeeded' },
]);
assert.equal(rejectedBeforeTransportCollected.toolTrace.events[0].result.schemaVersion, 'aishell.host-rejection.v1');
assert.equal(rejectedBeforeTransportCollected.metrics.retries, 1);
assert.deepEqual(wireCollected.result, collected.result);
assert.equal(Buffer.isBuffer(wireCollected.adapterTraceBytes), true);
await assert.rejects(() => collectAttemptEvidence({
  attempt: candidateAttempt, workspace, stateDirectory, preAttemptManifest, baselineManifest,
  benchmarkSetupEvidence, trustedProductionSetup: trusted,
  agentEvents: [{ type: 'item.completed', item: { ...agentEvents[0].item, unknown: true } }],
  finalAgent: { assertions: {} }, execution: { exitCode: 0, timedOut: false },
}), /invalid fields/u);
const missingExactBytes = structuredClone(agentEvents);
delete missingExactBytes[0].item.result_bytes_base64;
await assert.rejects(() => collectAttemptEvidence({
  attempt: candidateAttempt, workspace, stateDirectory, preAttemptManifest, baselineManifest,
  benchmarkSetupEvidence, trustedProductionSetup: trusted, agentEvents: missingExactBytes,
  finalAgent: { assertions: {} }, execution: { exitCode: 0, timedOut: false },
}), /invalid fields/u);

const providerTrace = Buffer.from(`${JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } })}\n`);
const providerSSE = Buffer.from([
  '{"type":"response.created","response":{"id":"main-1","model":"actual-model-snapshot"}}',
  '{"type":"response.completed","response":{"id":"main-1","model":"actual-model-snapshot","usage":{"input_tokens":1,"input_tokens_details":{"cached_tokens":0},"output_tokens":1,"output_tokens_details":{"reasoning_tokens":0}}}}',
  '{"type":"response.created","response":{"id":"review-1","model":"reviewer-model"}}',
  '{"type":"response.completed","response":{"id":"review-1","model":"reviewer-model","usage":{"input_tokens":2,"input_tokens_details":{"cached_tokens":1},"output_tokens":1,"output_tokens_details":{"reasoning_tokens":1}}}}',
  '',
].join('\n'));
const approvalReviewer = { mode: 'auto_review', modelSnapshots: ['reviewer-model'] };
const modelEvidence = JSON.parse(await observeProviderModel({
  providerTraceBytes: providerTrace, providerSSEBytes: providerSSE,
  mainModelSnapshot: 'actual-model-snapshot', approvalReviewer,
}));
assert.equal(modelEvidence.schema, 'aishell.provider-model-evidence.v3');
assert.deepEqual(modelEvidence.models, [
  { modelSnapshot: 'actual-model-snapshot', responseCount: 1 },
  { modelSnapshot: 'reviewer-model', responseCount: 1 },
]);
assert.equal('mainModelSnapshot' in modelEvidence, false);
assert.equal('approvalReviewer' in modelEvidence, false);
assert.deepEqual(extractProviderUsageFromSSETrace(providerSSE).usage, {
  source: 'provider', inputTokens: 3, cachedInputTokens: 1,
  outputTokens: 2, reasoningOutputTokens: 1, totalModelTokens: 5,
});
assert.equal(modelEvidence.providerTraceSHA256, sha256Hex(providerTrace));
assert.equal(modelEvidence.providerSSETraceSHA256, sha256Hex(providerSSE));
await assert.rejects(() => observeProviderModel({
  providerTraceBytes: Buffer.from(`${JSON.stringify({ type: 'thread.started', requested_model: 'echo-must-not-be-used' })}\n`),
  providerSSEBytes: Buffer.from(''),
  mainModelSnapshot: 'echo-must-not-be-used', approvalReviewer,
}), /provider SSE response pairs are incomplete/u);

for (const [key, value] of Object.entries(previous)) {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

process.stdout.write(`${JSON.stringify({
  schema: 'aishell.phase3_local_callbacks_self_test.v1', process: 'fake', mcp: 'fake', model: 'actual-provider-sse-only', status: 'valid',
})}\n`);
