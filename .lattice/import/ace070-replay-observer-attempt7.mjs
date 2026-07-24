import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { collectRepresentativeAttemptEvidence } from '../../benchmarks/representative-local-callbacks.mjs';

const attemptID = 'representative-007-workspace-persistence-warm-restore-candidate-r3';
const runDirectory = path.resolve('benchmarks/results/representative-production-20260723-v4/attempts', attemptID);
const readJSON = async (name) => JSON.parse(await readFile(path.join(runDirectory, name), 'utf8'));
const events = (await readFile(path.join(runDirectory, 'provider-events.jsonl'), 'utf8'))
  .split('\n').filter(Boolean).map(JSON.parse);
const evidence = await collectRepresentativeAttemptEvidence({
  attempt: {
    attemptID,
    sequence: 7,
    taskID: 'workspace-persistence-warm-restore',
    arm: 'candidate',
    repetition: 3,
  },
  workspace: path.join(runDirectory, 'workspace'),
  stateDirectory: path.join(runDirectory, 'runtime-state'),
  runDirectory,
  baselineManifest: await readJSON('baseline-manifest.json'),
  preAttemptManifest: await readJSON('pre-attempt-manifest.json'),
  benchmarkSetupEvidence: await readJSON('setup-evidence.json'),
  trustedProductionSetup: {},
  setupStepEvidence: [],
  artifactStore: path.join(runDirectory, 'runtime-state', 'evidence'),
  agentEvents: events,
  finalAgent: await readJSON('agent-result.json'),
  execution: { exitCode: 0, timedOut: false },
  mcpWireDirectory: path.join(runDirectory, 'mcp-wire'),
});
process.stdout.write(`${JSON.stringify({
  schema: 'aishell.ace070-observer-replay.v1',
  status: 'valid',
  toolCalls: evidence.metrics.toolCalls,
  actions: evidence.toolTrace.events.map(({ provider, tool, action }) => ({ provider, tool, action })),
  result: evidence.result,
})}\n`);
