import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { collectRepresentativeAttemptEvidence } from '../../benchmarks/representative-local-callbacks.mjs';

const runDirectory = path.resolve('benchmarks/results/representative-production-20260723-v2/attempts/representative-005-workspace-persistence-warm-restore-current-aishell-0.3.3-r2');
const readJSON = async (name) => JSON.parse(await readFile(path.join(runDirectory, name), 'utf8'));
const events = (await readFile(path.join(runDirectory, 'provider-events.jsonl'), 'utf8'))
  .split('\n').filter(Boolean).map(JSON.parse);
const evidence = await collectRepresentativeAttemptEvidence({
  attempt: {
    attemptID: 'representative-005-workspace-persistence-warm-restore-current-aishell-0.3.3-r2',
    sequence: 5,
    taskID: 'workspace-persistence-warm-restore',
    arm: 'current-aishell-0.3.3',
    repetition: 2,
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
  actions: evidence.toolTrace.events.map(({ tool, action }) => ({ tool, action })),
})}\n`);
