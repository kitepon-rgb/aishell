#!/usr/bin/env node

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { materializeRequestContract } from './materialize-capability-request.mjs';

const suite = JSON.parse(await readFile(new URL('./representative-suite.v1.json', import.meta.url)));
const catalog = JSON.parse(await readFile(new URL('./capability-fixtures.v1.json', import.meta.url)));
const execution = JSON.parse(await readFile(new URL('./representative-execution-contracts.v1.json', import.meta.url)));
const root = path.resolve('/benchmark-fixture');

for (const task of suite.tasks) {
  const fixture = catalog.fixtures.find(({id}) => id === task.fixture);
  const files = Object.fromEntries(Object.entries(fixture.seedFiles).map(([file, content]) =>
    [file, createHash('sha256').update(content).digest('hex')]));
  const digest = createHash('sha256').update(task.id).digest('hex');
  const manifest = {schema:'aishell.workspace-manifest.v1',root,fileCount:Object.keys(files).length,files,digest};
  const setupEvidence = {schema:'aishell.benchmark-setup-evidence.v1',taskId:task.id,workspaceRoot:root,
    preStateDigest:digest,checkpoint:'chk_fixture',cursor:'ws2:root:exclusion:generation:0',runId:'run_fixture',handles:['art_one','art_two']};
  const contract = materializeRequestContract({taskId:task.id,workspaceRoot:root,preAttemptManifest:manifest,
    baselineManifest:manifest,setupEvidence,suite,catalog,execution});
  assert.equal(contract.requiredCalls.length, Object.keys(execution.candidateRequiredActionsByTask[task.id]).length, task.id);
  assert.equal(JSON.stringify(contract).includes('fixture-bound'), false, task.id);
  for (const call of contract.requiredCalls) {
    assert.deepEqual(Object.keys(call.requestSubset).sort(), [...execution.requestTemplates[call.templateId]].sort(), task.id);
  }
}

const first = suite.tasks[0];
const fixture = catalog.fixtures.find(({id}) => id === first.fixture);
const files = Object.fromEntries(Object.entries(fixture.seedFiles).map(([file, content]) =>
  [file, createHash('sha256').update(content).digest('hex')]));
const manifest = {schema:'aishell.workspace-manifest.v1',root,fileCount:Object.keys(files).length,files,digest:'a'.repeat(64)};
assert.throws(() => materializeRequestContract({taskId:first.id,workspaceRoot:root,preAttemptManifest:manifest,baselineManifest:manifest,
  setupEvidence:{schema:'aishell.benchmark-setup-evidence.v1',taskId:first.id,workspaceRoot:root,preStateDigest:'b'.repeat(64)},
  suite,catalog,execution}), /invalid setup evidence/u);

process.stdout.write(`{"schema":"aishell.capability_request_materializer_self_test.v1","tasks":${suite.tasks.length},"status":"valid"}\n`);
