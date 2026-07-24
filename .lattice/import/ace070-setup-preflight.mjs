import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

import { createRepresentativeLocalCallbacks } from '../../benchmarks/representative-local-callbacks.mjs';
import { createRepresentativeProductionHarness } from '../../benchmarks/representative-production-harness.mjs';
import { buildRepresentativeAttemptManifest } from '../../benchmarks/representative-production-runner.mjs';
import { renderRepresentativePrompt } from '../../benchmarks/render-representative-prompt.mjs';

async function exists(file) {
  try { await stat(file); return true; }
  catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

const configurationPath = path.resolve(process.argv[2]);
const configuration = JSON.parse(await readFile(configurationPath, 'utf8'));
const manifest = await buildRepresentativeAttemptManifest(configuration.runConfiguration);
const outputDirectory = `${configuration.executorOptions.outputDirectory}-setup-preflight-v4`;
const local = createRepresentativeLocalCallbacks({ armBinaries: configuration.executorOptions.armBinaries });
const harness = createRepresentativeProductionHarness({
  executorOptions: {
    ...configuration.executorOptions,
    outputDirectory,
    codexCommand: '/usr/bin/true',
    timeoutMilliseconds: 30_000,
  },
  prepareSetup: local.prepareSetup,
  materializePrompt: local.materializePrompt,
  beforeAgentAttempt: local.beforeAgentAttempt,
  afterAgentAttempt: local.afterAgentAttempt,
  validateSetupEvidence: local.validateSetupEvidence,
  exchangeMCP: local.exchangeMCP,
  collectAttemptEvidence: local.collectRepresentativeAttemptEvidence,
  observeProviderModel: local.observeProviderModel,
  runProcess: local.runProcess,
});

const selected = manifest.attempts.filter(({ repetition }) => repetition === 1);
const failures = [];
for (const attempt of selected) {
  const prompt = await renderRepresentativePrompt(attempt.taskID, { materializeModelParameters: true });
  let stoppedAfterSetup = false;
  try {
    await harness.executor({
      attempt,
      isolation: manifest.isolation,
      armBinding: manifest.armBindings[attempt.arm],
      prompt,
    });
  } catch (error) {
    stoppedAfterSetup = await exists(path.join(outputDirectory, attempt.attemptID, 'codex-invocation.json'));
    if (!stoppedAfterSetup) process.stderr.write(`reason ${attempt.sequence}: ${error.message}\n`);
  }
  if (!stoppedAfterSetup) failures.push(attempt.attemptID);
  process.stderr.write(`${stoppedAfterSetup ? 'passed' : 'failed'} ${attempt.sequence}: ${attempt.attemptID}\n`);
}
process.stdout.write(`${JSON.stringify({
  schema: 'aishell.ace070-setup-preflight.v1', attempts: selected.length,
  status: failures.length === 0 ? 'valid' : 'invalid', failures,
})}\n`);
if (failures.length !== 0) process.exitCode = 1;
