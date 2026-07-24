import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createPhase3CodexExecutor } from '../../benchmarks/phase3-codex-executor.mjs';
import { createPhase3ProductionHarness } from '../../benchmarks/phase3-production-harness.mjs';
import { renderRepresentativePrompt } from '../../benchmarks/render-representative-prompt.mjs';

const root = '/Users/kite/Developer/aishell';
const configPath = path.join(root, '.lattice/import/ace035-phase3-harness-configuration.json');
const configuration = JSON.parse(await readFile(configPath, 'utf8'));
const manifestPath = path.resolve(path.dirname(configPath), configuration.manifestFile);
const callbackPath = path.resolve(path.dirname(configPath), configuration.callbacksModule);
const [manifest, callbacks] = await Promise.all([
  readFile(manifestPath, 'utf8').then(JSON.parse),
  import(pathToFileURL(callbackPath).href),
]);
const sequence = Number.parseInt(process.argv[2] ?? '1', 10);
if (!Number.isSafeInteger(sequence) || sequence < 1 || sequence > manifest.attempts.length) {
  throw new Error('usage: ace035-single-attempt-preflight.mjs [sequence] [output-directory]');
}
const outputDirectory = process.argv[3]
  ? path.resolve(process.argv[3])
  : path.join(root, `benchmarks/results/phase3-production-20260722-preflight-${sequence}`);
const harness = createPhase3ProductionHarness({
  executorOptions: { ...configuration.executorOptions, outputDirectory },
  runSetupStep: callbacks.runSetupStep,
  captureTrustedSetup: callbacks.captureTrustedSetup,
  exchangeMCP: callbacks.exchangeMCP,
  collectAttemptEvidence: callbacks.collectAttemptEvidence,
  observeProviderModel: callbacks.observeProviderModel,
  runProcess: callbacks.runProcess,
});
const attempt = manifest.attempts[sequence - 1];
const executeAttempt = createPhase3CodexExecutor(harness.executorOptions);
const record = await executeAttempt(Object.freeze({
  attempt: structuredClone(attempt),
  isolation: structuredClone(manifest.isolation),
  armBinding: structuredClone(manifest.armBindings[attempt.arm]),
  prompt: await renderRepresentativePrompt(attempt.taskID),
}));
process.stdout.write(`${JSON.stringify({ schema: 'aishell.phase3-single-attempt-preflight.v1', record }, null, 2)}\n`);
