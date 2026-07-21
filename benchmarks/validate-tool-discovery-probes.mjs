#!/usr/bin/env node

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const contract = JSON.parse(await readFile(new URL('./tool-discovery-probes.v1.json', import.meta.url)));
const tools = [
  'run_check', 'run_observe', 'artifact_read', 'workspace_snapshot', 'workspace_wait',
  'read_context', 'search_context', 'change_impact', 'apply_change_set',
];

assert.equal(contract.schemaVersion, 'aishell.tool-discovery-probes.v1');
assert.equal(contract.acceptance.applicableArm, 'candidate');
assert.equal(contract.acceptance.requiredPasses, 20);
assert.equal(contract.probes.length, 20);
assert.equal(new Set(contract.probes.map(({ id }) => id)).size, 20);
for (const tool of tools) {
  const probes = contract.probes.filter(({ expectedTool }) => expectedTool === tool);
  assert.deepEqual(new Set(probes.map(({ language }) => language)), new Set(['en', 'ja']), tool);
  assert.ok(probes.every(({ prompt, callRequired, forbiddenTools }) =>
    prompt.length >= 20 && callRequired === true && forbiddenTools.length >= 2 && !forbiddenTools.includes(tool)));
}
const noCall = contract.probes.filter(({ callRequired }) => callRequired === false);
assert.deepEqual(new Set(noCall.map(({ language }) => language)), new Set(['en', 'ja']));
assert.ok(noCall.every(({ expectedTool, forbiddenTools }) => expectedTool === null && tools.every((tool) => forbiddenTools.includes(tool))));

process.stdout.write(`${JSON.stringify({
  schema: 'aishell.tool_discovery_probe_validation.v1',
  tool_count: tools.length,
  probe_count: contract.probes.length,
  positive_probe_count: contract.probes.length - noCall.length,
  no_call_probe_count: noCall.length,
  languages: ['en', 'ja'],
  status: 'valid',
})}\n`);
