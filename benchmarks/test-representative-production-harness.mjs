#!/usr/bin/env node

import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { captureManifest } from './capture-workspace-manifest.mjs';
import {
  collectRepresentativeAttemptEvidence,
  materializeRepresentativePrompt,
  selectRepresentativeCapabilityCall,
} from './representative-local-callbacks.mjs';
import {
  createRepresentativeProductionHarness,
  invalidAgentOracle,
} from './representative-production-harness.mjs';
import { selectProbeAttempts } from './probe-representative-production.mjs';
import { renderRepresentativePrompt } from './render-representative-prompt.mjs';

const temporary = await mkdtemp(path.join(os.tmpdir(), 'aishell-representative-harness-'));
try {
  const eventGapPrompt = await renderRepresentativePrompt(
    'workspace-wait-event-gap', { materializeModelParameters: true },
  );
  const cursor = 'ws2:root:exclusion:generation:0';
  const boundEventGapPrompt = materializeRepresentativePrompt({
    attempt: { attemptID: 'event-gap-probe', taskID: 'workspace-wait-event-gap', arm: 'candidate' },
    prompt: eventGapPrompt,
    setup: { fields: { cursor }, trustedProductionSetup: {} },
  });
  assert.equal(boundEventGapPrompt.includes(JSON.stringify({ cursor })), true);
  assert.equal(boundEventGapPrompt.includes('{{AISHELL_VERIFIED_OPAQUE_SETUP_BINDINGS}}'), false);

  const harness = createRepresentativeProductionHarness({
    executorOptions: {
      outputDirectory: path.join(temporary, 'output'),
      codexCommand: '/usr/bin/true',
      armBinaries: { 'current-aishell-0.3.3': '/usr/bin/true', candidate: '/usr/bin/true' },
      sandboxConfiguration: { approvalPolicy: 'on-request', filesystem: 'workspace-write', network: false },
      approvalReviewer: { mode: 'auto_review', modelSnapshots: ['reviewer'] },
      commonHostCatalogDigest: 'a'.repeat(64), commonCodexArguments: [], timeoutMilliseconds: 1_000,
    },
    prepareSetup: async () => ({}), materializePrompt: async ({ prompt }) => prompt,
    beforeAgentAttempt: async () => {}, afterAgentAttempt: async () => {},
    exchangeMCP: async () => Buffer.alloc(0), collectAttemptEvidence: async () => ({}),
    observeProviderModel: async () => Buffer.alloc(0), runProcess: async () => ({}),
  });
  assert.equal(typeof harness.run, 'function');
  assert.equal(typeof harness.executor, 'function');
  const probeManifest = { attempts: [
    { sequence: 1, taskID: 'task-a', arm: 'candidate', repetition: 1 },
    { sequence: 2, taskID: 'task-a', arm: 'native', repetition: 1 },
  ] };
  assert.deepEqual(selectProbeAttempts(probeManifest, [
    { taskID: 'task-a', arm: 'candidate', repetition: 1 },
  ]).map(({ sequence }) => sequence), [1]);
  assert.throws(() => selectProbeAttempts(probeManifest, [
    { taskID: 'task-a', arm: 'candidate', repetition: 1 },
    { taskID: 'task-a', arm: 'candidate', repetition: 1 },
  ]), /duplicated/u);
  const errors = [
    { isError: true, result: { error: { code: 'CURSOR_EXPIRED' } } },
    { isError: true, result: { error: { code: 'RESCAN_REQUIRED' } } },
  ];
  assert.equal(selectRepresentativeCapabilityCall(errors, 'RESCAN_REQUIRED'), errors[1]);
  assert.equal(selectRepresentativeCapabilityCall(errors, 'STALE_CONTENT'), null);

  const workspace = path.join(temporary, 'workspace');
  await mkdir(path.join(workspace, 'src'), { recursive: true });
  await writeFile(path.join(workspace, 'src/state.txt'), 'one\n');
  await writeFile(path.join(workspace, 'src/a.txt'), 'A1\n');
  await writeFile(path.join(workspace, 'src/b.txt'), 'B1\n');
  const baseline = await captureManifest(workspace);
  const evidence = await collectRepresentativeAttemptEvidence({
    attempt: {
      attemptID: 'native-unit', taskID: 'bilingual-workflow-japanese', arm: 'native', repetition: 1,
    },
    workspace,
    stateDirectory: path.join(temporary, 'state'),
    baselineManifest: baseline,
    preAttemptManifest: baseline,
    benchmarkSetupEvidence: {
      schema: 'aishell.benchmark-setup-evidence.v1', taskId: 'bilingual-workflow-japanese',
      workspaceRoot: workspace, preStateDigest: baseline.digest,
    },
    agentEvents: [],
    finalAgent: {
      schema: 'aishell.agent-benchmark-report.v1', taskId: 'bilingual-workflow-japanese',
      assertions: { apply: [['src/a.txt', 'A2\n'], ['src/b.txt', 'B2\n']] },
    },
    execution: { exitCode: 0, timedOut: false, wallMilliseconds: 1 },
    artifactStore: path.join(temporary, 'artifacts'),
  });
  assert.deepEqual(evidence.result.apply, [['src/a.txt', 'A2\n'], ['src/b.txt', 'B2\n']]);
  assert.equal(evidence.adapterTraceBytes, null);
  assert.deepEqual(evidence.toolTrace.events, []);
  const invalidEvidence = await collectRepresentativeAttemptEvidence({
    attempt: {
      attemptID: 'invalid-agent-unit', taskID: 'bilingual-workflow-japanese', arm: 'native', repetition: 1,
    },
    workspace,
    stateDirectory: path.join(temporary, 'invalid-state'),
    baselineManifest: baseline,
    preAttemptManifest: baseline,
    benchmarkSetupEvidence: {
      schema: 'aishell.benchmark-setup-evidence.v1', taskId: 'bilingual-workflow-japanese',
      workspaceRoot: workspace, preStateDigest: baseline.digest,
    },
    agentEvents: [],
    finalAgent: {
      schema: 'aishell.invalid-agent-result.v1', taskId: 'bilingual-workflow-japanese',
      reason: 'final_agent_message_is_not_json',
    },
    execution: { exitCode: 0, timedOut: false, wallMilliseconds: 1 },
    artifactStore: path.join(temporary, 'invalid-artifacts'),
  });
  assert.deepEqual(invalidEvidence.result, {});
  assert.deepEqual(invalidAgentOracle(
    { taskID: 'bilingual-workflow-japanese', arm: 'native' },
    { schema: 'aishell.invalid-agent-result.v1', reason: 'final_agent_message_is_not_json' },
  ), {
    schema: 'aishell.capability-oracle-result.v1',
    taskId: 'bilingual-workflow-japanese',
    arm: 'native',
    solved: false,
    failures: ['agent report: final_agent_message_is_not_json'],
  });
  process.stdout.write('representative production harness tests passed\n');
} finally {
  await rm(temporary, { recursive: true, force: true });
}
