#!/usr/bin/env node

import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { captureManifest } from './capture-workspace-manifest.mjs';
import {
  captureTrustedSetup,
  collectAttemptEvidence,
  exchangeMCP,
  observeProviderModel,
  runProcess,
  runSetupStep,
} from './phase3-local-callbacks.mjs';
import { prepareCandidateRequests } from './phase3-representative-runner.mjs';
import { canonicalJSONBytes, sha256Hex } from './production-v2-benchmark-adapter.mjs';

const root = await mkdtemp(path.join(tmpdir(), 'aishell-phase3-local-callbacks-'));
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
  if(process.env.AISHELL_TOOL_PROFILE==='development'&&name==='workspace_snapshot'&&message.params.arguments.project_profile)process.exit(3);
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
    {kind:'evidence',itemID:'evidence-direct',providerID:'static-import',subject:{kind:'path',path:bad==='subject'?'src/wrong.mjs':'src/b.mjs'},evidenceID:'evidence-1',inputIdentity:tuple(['input_path','src/a.mjs','0',aSHA]),relation:bad==='relation'?'lexical_reference':'declared_dependency',locator:{path:'src/b.mjs',contentSHA256:bad==='sha'?'${'7'.repeat(64)}':bSHA,startOffset:19,endOffset:26,edgeID:tuple(['src/b.mjs','src/a.mjs'])},evidenceStrength:'declared_edge',summary:'direct static import'},
    {kind:'evidence',itemID:'evidence-test',providerID:'static-import',subject:{kind:'test',path:bad==='transitive-subject'?'test/wrong.test.mjs':'test/b.test.mjs'},evidenceID:'evidence-2',inputIdentity:tuple(['input_path','src/a.mjs','0',aSHA]),relation:bad==='transitive-relation'?'lexical_reference':'declared_dependency',locator:{path:'test/b.test.mjs',contentSHA256:testSHA,startOffset:8,endOffset:20,edgeID:tuple(['test/b.test.mjs','src/b.mjs'])},evidenceStrength:'declared_edge',summary:'transitive static import'}];
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
assert.equal(Buffer.isBuffer(collected.adapterTraceBytes), true);
assert.equal(collected.toolTrace.events[0].action, 'execute');
assert.equal(collected.metrics.toolCalls, 1);
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

const metadataBytes = canonicalJSONBytes({ model_snapshot: 'actual-model-snapshot' });
const providerTrace = Buffer.from(`${JSON.stringify({
  type: 'provider.metadata', metadata_bytes_base64: metadataBytes.toString('base64'),
})}\n`);
const modelEvidence = JSON.parse(await observeProviderModel({ providerTraceBytes: providerTrace }));
assert.equal(modelEvidence.modelSnapshot, 'actual-model-snapshot');
assert.equal(modelEvidence.providerTraceSHA256, sha256Hex(providerTrace));
await assert.rejects(() => observeProviderModel({
  providerTraceBytes: Buffer.from(`${JSON.stringify({ type: 'thread.started', requested_model: 'echo-must-not-be-used' })}\n`),
}), /actual provider metadata event is unavailable/u);

for (const [key, value] of Object.entries(previous)) {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

process.stdout.write(`${JSON.stringify({
  schema: 'aishell.phase3_local_callbacks_self_test.v1', process: 'fake', mcp: 'fake', model: 'actual-metadata-only', status: 'valid',
})}\n`);
