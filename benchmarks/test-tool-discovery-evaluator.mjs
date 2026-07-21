#!/usr/bin/env node

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { evaluateDiscoveryProbe } from './evaluate-tool-discovery-probe.mjs';
import { renderDiscoveryPrompt } from './render-tool-discovery-prompt.mjs';

const input = renderDiscoveryPrompt('en-run-check');
assert.deepEqual(Object.keys(input).sort(), ['prompt','schema']);
assert.equal(JSON.stringify(input).includes('expectedTool'), false, 'model inputへoracleを含めない');
const contract = JSON.parse(await readFile(new URL('./tool-discovery-probes.v1.json', import.meta.url)));
const toolNames = ['run_check','run_observe','artifact_read','workspace_snapshot','workspace_wait','read_context','search_context','change_impact','apply_change_set'];
for (const probe of contract.probes) {
  const rendered = JSON.stringify(renderDiscoveryPrompt(probe.id));
  assert.equal(rendered.includes(probe.id), false, `model inputへsemantic probe idを含めない: ${probe.id}`);
  for (const tool of toolNames) assert.equal(rendered.includes(tool), false, `model inputへtool識別子を含めない: ${probe.id}/${tool}`);
}
assert.equal(evaluateDiscoveryProbe({probeId:'en-run-check',armId:'candidate',trace:{schema:'aishell.tool-discovery-trace.v1',probeId:'en-run-check',calls:[{tool:'run_check'}]}}).passed, true);
assert.equal(evaluateDiscoveryProbe({probeId:'en-run-check',armId:'candidate',trace:{schema:'aishell.tool-discovery-trace.v1',probeId:'en-run-check',calls:[{tool:'run_check'},{tool:'run_check'}]}}).passed, false);
assert.equal(evaluateDiscoveryProbe({probeId:'en-run-check',armId:'candidate',trace:{schema:'aishell.tool-discovery-trace.v1',probeId:'en-run-check',calls:[{tool:'artifact_read'}]}}).passed, false);
assert.equal(evaluateDiscoveryProbe({probeId:'ja-no-call-control',armId:'candidate',trace:{schema:'aishell.tool-discovery-trace.v1',probeId:'ja-no-call-control',calls:[]}}).passed, true);
assert.equal(evaluateDiscoveryProbe({probeId:'ja-no-call-control',armId:'candidate',trace:{schema:'aishell.tool-discovery-trace.v1',probeId:'ja-no-call-control',calls:[{tool:'workspace_snapshot'}]}}).passed, false);
assert.throws(() => evaluateDiscoveryProbe({probeId:'en-run-check',armId:'native',trace:{schema:'aishell.tool-discovery-trace.v1',probeId:'en-run-check',calls:[]}}), /not applicable/u);

process.stdout.write('{"schema":"aishell.tool_discovery_evaluator_self_test.v1","cases":6,"oracle_leakage":0,"status":"valid"}\n');
