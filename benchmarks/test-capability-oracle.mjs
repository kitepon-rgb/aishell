#!/usr/bin/env node

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { evaluateAttempt, subsetFailures } from './evaluate-capability-oracle.mjs';
import { observeAttempt } from './observe-capability-attempt.mjs';
import { captureManifest } from './capture-workspace-manifest.mjs';
import { materializeRequestContract } from './materialize-capability-request.mjs';

const execution = JSON.parse(await (await import('node:fs/promises')).readFile(new URL('./representative-execution-contracts.v1.json', import.meta.url)));
const suite = JSON.parse(await (await import('node:fs/promises')).readFile(new URL('./representative-suite.v1.json', import.meta.url)));
const catalog = JSON.parse(await (await import('node:fs/promises')).readFile(new URL('./capability-fixtures.v1.json', import.meta.url)));

assert.deepEqual(
  subsetFailures(['npm test', 'npm run lint'], ['npm run lint', 'npm test'], 'assertions.commands'),
  [],
  'commands are a set; discovery order is not part of the oracle',
);
assert.notDeepEqual(
  subsetFailures([['src/a.mjs', 'src/b.mjs']], [['src/b.mjs', 'src/a.mjs']], 'assertions.renames'),
  [],
  'ordered tuple arrays must retain their semantic order',
);

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

const root = await mkdtemp(path.join(tmpdir(), 'aishell-oracle-'));
try {
  const workspace = path.join(root, 'workspace');
  await mkdir(path.join(workspace, 'src'), {recursive:true});
  await writeFile(path.join(workspace, 'src/a.txt'), 'alpha\n');
  await writeFile(path.join(workspace, 'src/b.txt'), 'beta\n');
  const processFile = path.join(root, 'process.json');
  const telemetryFile = path.join(root, 'telemetry.json');
  const toolTraceFile = path.join(root, 'tool-trace.json');
  const agentReportFile = path.join(root, 'agent-report.json');
  const preAttemptFile = path.join(root, 'pre-attempt.json');
  const setupEvidenceFile = path.join(root, 'setup-evidence.json');
  const requestContractFile = path.join(root, 'request-contract.json');
  await writeFile(processFile, JSON.stringify({agentExitCode:0,agentTimedOut:false}));
  await writeFile(telemetryFile, JSON.stringify({maxFullRescans:0}));
  const result = {schemaVersion:'aishell.workspace-snapshot.v2',entries:[{path:'generated/0000.txt'},{path:'src/a.txt'},{path:'src/b.txt'}]};
  const current = await captureManifest(workspace);
  await writeFile(preAttemptFile, JSON.stringify(current));
  const setupEvidence = {schema:'aishell.benchmark-setup-evidence.v1',taskId:'workspace-persistence-warm-restore',
    workspaceRoot:path.resolve(workspace),preStateDigest:current.digest,checkpoint:'chk_workspace_seed'};
  await writeFile(setupEvidenceFile, JSON.stringify(setupEvidence));
  const requestContract = materializeRequestContract({taskId:'workspace-persistence-warm-restore',workspaceRoot:workspace,
    preAttemptManifest:current,baselineManifest:null,setupEvidence,suite,catalog,execution});
  await writeFile(requestContractFile, JSON.stringify(requestContract));
  const request = requestContract.requiredCalls[0].requestSubset;
  const resultDigest = createHash('sha256').update(canonical(result)).digest('hex');
  await writeFile(toolTraceFile, JSON.stringify({events:[{provider:'aishell',tool:'workspace_snapshot',action:'restore',status:'succeeded',isError:false,metadata:{preStateDigest:current.digest},request,result,resultDigest}]}));
  await writeFile(agentReportFile, JSON.stringify({schema:'aishell.agent-benchmark-report.v1',taskId:'workspace-persistence-warm-restore',assertions:{mustContainFiles:['src/a.txt','src/b.txt']}}));

  const nativeActual = await observeAttempt({
    taskId:'workspace-persistence-warm-restore', armId:'native', workspace, processFile, agentReportFile, preAttemptFile, setupEvidenceFile, requestContractFile,
  });
  const native = await evaluateAttempt({
    taskId:'workspace-persistence-warm-restore', armId:'native', actual:nativeActual,
  });
  assert.equal(native.solved, true, 'native must not require unavailable post-0.3.3 telemetry');

  const candidateActual = await observeAttempt({
    taskId:'workspace-persistence-warm-restore', armId:'candidate', workspace, processFile, telemetryFile, toolTraceFile, agentReportFile, preAttemptFile, setupEvidenceFile, requestContractFile,
  });
  const candidate = await evaluateAttempt({
    taskId:'workspace-persistence-warm-restore', armId:'candidate', actual:candidateActual,
  });
  assert.equal(candidate.solved, true);

  await writeFile(telemetryFile, JSON.stringify({maxFullRescans:1}));
  const failedActual = await observeAttempt({
    taskId:'workspace-persistence-warm-restore', armId:'candidate', workspace, processFile, telemetryFile, toolTraceFile, agentReportFile, preAttemptFile, setupEvidenceFile, requestContractFile,
  });
  const failed = await evaluateAttempt({
    taskId:'workspace-persistence-warm-restore', armId:'candidate', actual:failedActual,
  });
  assert.equal(failed.solved, false);
  assert.match(failed.failures.join('\n'), /maxFullRescans/u);
} finally {
  await rm(root, {recursive:true,force:true});
}

process.stdout.write('{"schema":"aishell.capability_oracle_self_test.v2","cases":3,"observer":"filesystem+process+telemetry","status":"valid"}\n');
