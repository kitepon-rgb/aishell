#!/usr/bin/env node

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { evaluateAttempt } from './evaluate-capability-oracle.mjs';
import { createRepresentativeLocalCallbacks } from './representative-local-callbacks.mjs';
import { createRepresentativeProductionHarness } from './representative-production-harness.mjs';
import { buildRepresentativeAttemptManifest } from './representative-production-runner.mjs';
import { renderRepresentativePrompt } from './render-representative-prompt.mjs';

export function selectProbeAttempts(manifest, selectors) {
  if (!Array.isArray(selectors) || selectors.length === 0) throw new Error('probe selectors are required');
  const selected = selectors.map((selector) => {
    if (!selector || typeof selector !== 'object' || Array.isArray(selector)
      || typeof selector.taskID !== 'string' || typeof selector.arm !== 'string'
      || !Number.isSafeInteger(selector.repetition) || selector.repetition < 1) {
      throw new Error('probe selector is invalid');
    }
    const matches = manifest.attempts.filter((attempt) => attempt.taskID === selector.taskID
      && attempt.arm === selector.arm && attempt.repetition === selector.repetition);
    if (matches.length !== 1) throw new Error(`probe selector does not resolve exactly: ${selector.taskID}`);
    return matches[0];
  });
  if (new Set(selected.map(({ sequence }) => sequence)).size !== selected.length) {
    throw new Error('probe selectors are duplicated');
  }
  return selected;
}

async function main() {
  const configurationFile = process.argv[2];
  if (!configurationFile) throw new Error('usage: probe-representative-production.mjs <configuration.json>');
  const configurationPath = path.resolve(configurationFile);
  const configuration = JSON.parse(await readFile(configurationPath, 'utf8'));
  const manifest = await buildRepresentativeAttemptManifest(configuration.runConfiguration);
  const attempts = selectProbeAttempts(manifest, configuration.probeSelectors);
  const local = createRepresentativeLocalCallbacks({ armBinaries: configuration.executorOptions.armBinaries });
  const harness = createRepresentativeProductionHarness({
    executorOptions: configuration.executorOptions,
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
  const records = [];
  for (const attempt of attempts) {
    const prompt = await renderRepresentativePrompt(attempt.taskID, { materializeModelParameters: true });
    const record = await harness.executor({
      attempt: structuredClone(attempt), isolation: structuredClone(manifest.isolation),
      armBinding: structuredClone(manifest.armBindings[attempt.arm]), prompt,
    });
    const evidence = JSON.parse(await readFile(path.join(
      configuration.executorOptions.outputDirectory, attempt.attemptID, 'observer-evidence.json',
    ), 'utf8'));
    const oracle = await evaluateAttempt({ taskId: attempt.taskID, armId: attempt.arm, actual: evidence });
    records.push({ attempt, record, oracle });
    process.stderr.write(`probed ${records.length}/${attempts.length}: ${attempt.attemptID} solved=${oracle.solved}\n`);
  }
  const result = {
    schema: 'aishell.representative-production-probe.v1',
    status: records.every(({ oracle }) => oracle.solved) ? 'valid' : 'failed',
    records,
  };
  const outputFile = path.resolve(path.dirname(configurationPath), configuration.probeResultFile);
  await writeFile(outputFile, `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx' });
  process.stdout.write(`${JSON.stringify({ status: result.status, attempts: records.length, outputFile })}\n`);
  if (result.status !== 'valid') process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
