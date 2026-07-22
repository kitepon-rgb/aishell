#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { evaluateDiscoveryProbe } from './evaluate-tool-discovery-probe.mjs';
import { renderDiscoveryPrompt } from './render-tool-discovery-prompt.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const contract = JSON.parse(await readFile(path.join(here, 'tool-discovery-probes.v1.json'), 'utf8'));
const proxy = path.join(here, 'tool-discovery-trace-proxy.mjs');

function argument(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index < 0 ? fallback : process.argv[index + 1];
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function run(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {...options, stdio:['ignore','pipe','pipe']});
    const stdout = [];
    const stderr = [];
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({
      code: code ?? -1, signal,
      stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr),
    }));
  });
}

const binary = path.resolve(argument('binary', path.join(here, '..', '.build', 'debug', 'aishell-mcp')));
const output = path.resolve(argument('output', path.join(here, '..', 'docs', 'evidence', 'data', 'ace-065-tool-discovery-model-results.json')));
const model = argument('model', 'gpt-5.6-terra');
const reasoning = argument('reasoning', 'low');
const concurrency = Number.parseInt(argument('concurrency', '4'), 10);
const selectedProbeID = argument('probe', null);
if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 8) throw new Error('concurrency must be 1...8');
const probes = selectedProbeID === null ? contract.probes : contract.probes.filter(({id}) => id === selectedProbeID);
if (probes.length === 0) throw new Error(`unknown probe: ${selectedProbeID}`);

const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'aishell-discovery-'));
const results = new Array(probes.length);
let cursor = 0;

async function execute(index) {
  const probe = probes[index];
  const directory = path.join(temporaryRoot, probe.id);
  const workspace = path.join(directory, 'workspace');
  const state = path.join(directory, 'state');
  const tracePath = path.join(directory, 'calls.jsonl');
  await mkdir(workspace, {recursive:true});
  await mkdir(state, {recursive:true});
  await writeFile(tracePath, '');
  await mkdir(path.join(workspace, 'Sources', 'DiscoveryFixture'), {recursive:true});
  await mkdir(path.join(workspace, 'Tests', 'DiscoveryFixtureTests'), {recursive:true});
  await writeFile(path.join(workspace, 'Package.swift'), `// swift-tools-version: 6.0\nimport PackageDescription\nlet package = Package(name: "DiscoveryFixture", targets: [.target(name: "DiscoveryFixture"), .testTarget(name: "DiscoveryFixtureTests", dependencies: ["DiscoveryFixture"])])\n`);
  await writeFile(path.join(workspace, 'Sources', 'DiscoveryFixture', 'Fixture.swift'), 'public func fixtureValue() -> Int { 1 }\n');
  await writeFile(path.join(workspace, 'Tests', 'DiscoveryFixtureTests', 'FixtureTests.swift'), 'import Testing\n@testable import DiscoveryFixture\n@Test func fixture() { #expect(fixtureValue() == 1) }\n');
  await writeFile(path.join(workspace, 'README.md'), '# Discovery Fixture\n');
  await writeFile(path.join(state, 'runtime.json'), `${JSON.stringify({
    allowedRootPaths:[workspace], isPaused:false, updatedAt:'2001-01-01T00:00:00Z',
  })}\n`);
  const prompt = renderDiscoveryPrompt(probe.id).prompt;
  const invocation = [
    'exec', '--json', '--ephemeral', '--ignore-user-config', '--ignore-rules', '--skip-git-repo-check',
    '--color', 'never', '--dangerously-bypass-approvals-and-sandbox', '--disable', 'shell_tool',
    '--model', model, '--config', `model_reasoning_effort=${JSON.stringify(reasoning)}`, '--cd', workspace,
    '--config', `mcp_servers.aishell.command=${JSON.stringify(process.execPath)}`,
    '--config', `mcp_servers.aishell.args=${JSON.stringify([proxy,binary])}`,
    '--config', `mcp_servers.aishell.env={ AISHELL_STATE_DIRECTORY = ${JSON.stringify(state)}, AISHELL_TOOL_PROFILE = ${JSON.stringify('development')}, AISHELL_CAPABILITY_SET = ${JSON.stringify('expanded-v1')}, AISHELL_DISCOVERY_TRACE_PATH = ${JSON.stringify(tracePath)}, AISHELL_DISCOVERY_EXPECTED_TOOL = ${JSON.stringify(probe.expectedTool ?? '')} }`,
    prompt,
  ];
  const execution = await run('codex', invocation, {cwd:workspace, env:process.env});
  if (execution.code !== 0) {
    process.stderr.write(`${probe.id}: codex exit ${execution.code}\n${execution.stderr.toString('utf8')}\n`);
  }
  const rawTrace = await readFile(tracePath, 'utf8');
  const calls = rawTrace.trim().length === 0 ? [] : rawTrace.trim().split('\n').map((line) => JSON.parse(line));
  const trace = {schema:'aishell.tool-discovery-trace.v1',probeId:probe.id,calls};
  const evaluation = evaluateDiscoveryProbe({probeId:probe.id,armId:'candidate',trace});
  if (!evaluation.passed) {
    process.stderr.write(`${probe.id}: provider events\n${execution.stdout.toString('utf8')}\n${probe.id}: stderr\n${execution.stderr.toString('utf8')}\n`);
  }
  results[index] = {
    probeId:probe.id, language:probe.language, prompt, promptOverride:false, model, reasoning,
    invocation:{command:'codex',arguments:invocation.map((value,index) => index === invocation.length - 1 ? '<prompt>' : value)},
    exitCode:execution.code, signal:execution.signal, trace, evaluation,
    codexJSONLSHA256:sha256(execution.stdout), stderrSHA256:sha256(execution.stderr),
  };
  process.stderr.write(`${probe.id}: ${evaluation.passed ? 'PASS' : 'FAIL'} [${calls.map(({tool}) => tool).join(', ')}]\n`);
}

async function worker() {
  while (true) {
    const index = cursor;
    cursor += 1;
    if (index >= probes.length) return;
    await execute(index);
  }
}

try {
  await Promise.all(Array.from({length:Math.min(concurrency,probes.length)}, () => worker()));
  const summary = {
    passed:results.filter(({evaluation}) => evaluation.passed).length,
    total:results.length,
    misroutes:results.reduce((sum,{evaluation}) => sum + evaluation.misroutes, 0),
    unnecessaryCalls:results.reduce((sum,{evaluation}) => sum + evaluation.unnecessaryCalls, 0),
  };
  await mkdir(path.dirname(output), {recursive:true});
  await writeFile(output, `${JSON.stringify({
    schema:'aishell.tool-discovery-model-suite.v1', generatedAt:new Date().toISOString(),
    codexVersion:(await run('codex',['--version'],{env:process.env})).stdout.toString('utf8').trim(),
    binarySHA256:sha256(await readFile(binary)), model, reasoning, summary, results,
  }, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(summary)}\n`);
  const requiredPasses = selectedProbeID === null ? contract.acceptance.requiredPasses : probes.length;
  if (summary.passed !== requiredPasses || summary.misroutes !== 0 || summary.unnecessaryCalls !== 0) process.exitCode = 1;
} finally {
  await rm(temporaryRoot, {recursive:true,force:true});
}
