#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const contract = JSON.parse(await readFile(new URL('./tool-discovery-probes.v1.json', import.meta.url)));

export function renderDiscoveryPrompt(probeId) {
  const probe = contract.probes.find(({id}) => id === probeId);
  if (!probe) throw new Error(`unknown discovery probe: ${probeId}`);
  return {schema:'aishell.tool-discovery-model-input.v1', prompt:probe.prompt};
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const index = process.argv.indexOf('--probe');
  if (index < 0 || !process.argv[index + 1]) throw new Error('usage: render-tool-discovery-prompt.mjs --probe <id>');
  process.stdout.write(`${JSON.stringify(renderDiscoveryPrompt(process.argv[index + 1]))}\n`);
}
