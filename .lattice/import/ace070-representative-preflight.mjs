import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { createRepresentativeLocalCallbacks } from '../../benchmarks/representative-local-callbacks.mjs';
import { createRepresentativeProductionHarness } from '../../benchmarks/representative-production-harness.mjs';
import { buildRepresentativeAttemptManifest } from '../../benchmarks/representative-production-runner.mjs';
import { renderRepresentativePrompt } from '../../benchmarks/render-representative-prompt.mjs';

const configurationPath = path.resolve(process.argv[2]);
const configuration = JSON.parse(await readFile(configurationPath, 'utf8'));
const manifest = await buildRepresentativeAttemptManifest(configuration.runConfiguration);
const attemptIndex = Number(process.argv[3] ?? 0);
if (!Number.isSafeInteger(attemptIndex) || attemptIndex < 0 || attemptIndex >= manifest.attempts.length) {
  throw new Error('attempt index is invalid');
}
const attempt = manifest.attempts[attemptIndex];
const local = createRepresentativeLocalCallbacks({ armBinaries: configuration.executorOptions.armBinaries });
const harness = createRepresentativeProductionHarness({
  executorOptions: {
    ...configuration.executorOptions,
    outputDirectory: `${configuration.executorOptions.outputDirectory}-preflight-${attempt.sequence}-v1`,
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
const prompt = await renderRepresentativePrompt(attempt.taskID, { materializeModelParameters: true });
const record = await harness.executor({
  attempt,
  isolation: manifest.isolation,
  armBinding: manifest.armBindings[attempt.arm],
  prompt,
});
process.stdout.write(`${JSON.stringify({ schema: 'aishell.ace070-preflight.v1', record }, null, 2)}\n`);
