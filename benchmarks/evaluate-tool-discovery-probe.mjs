#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const contract = JSON.parse(await readFile(new URL('./tool-discovery-probes.v1.json', import.meta.url)));

export function evaluateDiscoveryProbe({probeId, armId, trace}) {
  const probe = contract.probes.find(({id}) => id === probeId);
  if (!probe) throw new Error(`unknown discovery probe: ${probeId}`);
  if (armId !== contract.acceptance.applicableArm) throw new Error(`discovery probe is not applicable to arm: ${armId}`);
  if (trace?.schema !== 'aishell.tool-discovery-trace.v1' || trace.probeId !== probeId || !Array.isArray(trace.calls)
    || trace.calls.some((call) => !call || typeof call.tool !== 'string')) throw new Error(`invalid discovery trace: ${probeId}`);
  const actualTools = trace.calls.map(({tool}) => tool);
  const forbidden = new Set(probe.forbiddenTools);
  const expectedCount = probe.callRequired ? actualTools.filter((tool) => tool === probe.expectedTool).length : 0;
  const expectedIndex = probe.callRequired ? actualTools.indexOf(probe.expectedTool) : -1;
  const misroutes = actualTools.filter((tool) => forbidden.has(tool)).length;
  const supportingCalls = probe.callRequired && expectedIndex >= 0
    ? actualTools.slice(0, expectedIndex).filter((tool) => tool !== probe.expectedTool && !forbidden.has(tool)).length : 0;
  const unnecessaryCalls = probe.callRequired
    ? (expectedIndex < 0 ? 0 : actualTools.length - expectedIndex - 1) + Math.max(0, expectedCount - 1)
    : actualTools.length;
  const passed = probe.callRequired
    ? expectedCount === 1 && misroutes === 0 && unnecessaryCalls === 0
    : actualTools.length === 0;
  return {
    schema:'aishell.tool-discovery-result.v1', probeId, arm:armId, passed,
    expectedCallCount:probe.callRequired ? 1 : 0, actualCallCount:actualTools.length,
    supportingCalls, misroutes, unnecessaryCalls,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, value, index, values) => {
    if (value.startsWith('--')) pairs.push([value.slice(2), values[index + 1]]);
    return pairs;
  }, []));
  if (!args.probe || !args.arm || !args.trace) throw new Error('usage: evaluate-tool-discovery-probe.mjs --probe <id> --arm candidate --trace <json>');
  const result = evaluateDiscoveryProbe({probeId:args.probe,armId:args.arm,trace:JSON.parse(await readFile(args.trace, 'utf8'))});
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (!result.passed) process.exitCode = 1;
}
