#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { appendFileSync, closeSync, openSync } from 'node:fs';
import path from 'node:path';

function requiredAbsolute(value, label) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || path.normalize(value) !== value || value.includes('\0')) {
    throw new Error(`${label} must be a normalized absolute path`);
  }
  return value;
}

const target = requiredAbsolute(process.argv[2], 'AIShell MCP target');
const tracePath = requiredAbsolute(process.env.AISHELL_DISCOVERY_TRACE_PATH, 'discovery trace path');
const expectedTool = process.env.AISHELL_DISCOVERY_EXPECTED_TOOL || null;
if (process.argv.length !== 3) throw new Error('discovery trace proxy accepts exactly one target');
closeSync(openSync(tracePath, 'w'));

const childEnvironment = { ...process.env };
delete childEnvironment.AISHELL_DISCOVERY_TRACE_PATH;
delete childEnvironment.AISHELL_DISCOVERY_EXPECTED_TOOL;
const child = spawn(target, [], { env: childEnvironment, stdio: ['pipe', 'pipe', 'inherit'] });
const listRequestIDs = new Set();

function lines(stream, visit) {
  let pending = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk) => {
    pending += chunk;
    while (true) {
      const newline = pending.indexOf('\n');
      if (newline < 0) break;
      const line = pending.slice(0, newline);
      pending = pending.slice(newline + 1);
      if (line.length > 0) visit(line);
    }
  });
}

lines(process.stdin, (line) => {
  let request;
  try { request = JSON.parse(line); } catch { child.stdin.write(`${line}\n`); return; }
  if (request?.method === 'tools/list') listRequestIDs.add(JSON.stringify(request.id));
  if (request?.method !== 'tools/call') {
    child.stdin.write(`${line}\n`);
    return;
  }
  const tool = request.params?.name ?? null;
  appendFileSync(tracePath, `${JSON.stringify({tool})}\n`, 'utf8');
  const terminal = tool === expectedTool || expectedTool === null;
  const terminalResults = {
    run_check:'Repository check completed and complete diagnostics were retained.',
    run_observe:'The existing managed run was observed and the requested wait or cancellation completed.',
    artifact_read:'The retained logs were compared around the root error and the comparison is complete.',
    workspace_snapshot:'Workspace, Git and branch/worktree differences, and project commands were summarized completely.',
    workspace_wait:'A file change was observed after the bound cursor without polling.',
    read_context:'The requested files and symbol ranges were read under the shared byte budget.',
    search_context:'All requested regex and fixed-string searches completed with changed files and tests prioritized.',
    change_impact:'Affected symbols, dependencies, and tests were identified with evidence.',
    apply_change_set:'Three SHA-guarded edits were applied atomically and the resulting diff was retained.',
  };
  const text = terminal
    ? `${terminalResults[tool] ?? 'No workspace access was required.'} The requested outcome is complete; do not retry or call another tool.`
    : 'Supporting context is ready. Continue to the requested outcome with the best matching listed tool.';
  process.stdout.write(`${JSON.stringify({
    jsonrpc:'2.0', id:request.id, result:{content:[{type:'text',text}],isError:false},
  })}\n`);
});
process.stdin.on('end', () => child.stdin.end());

lines(child.stdout, (line) => {
  let response;
  try { response = JSON.parse(line); } catch { process.stdout.write(`${line}\n`); return; }
  const key = JSON.stringify(response?.id);
  if (listRequestIDs.delete(key) && Array.isArray(response?.result?.tools)) {
    response.result.tools = response.result.tools.map((tool) => ({
      name:tool.name, title:tool.title, description:tool.description,
      inputSchema:{type:'object',properties:{},additionalProperties:false},
      annotations:tool.annotations,
    }));
  }
  process.stdout.write(`${JSON.stringify(response)}\n`);
});

let childError = null;
child.once('error', (error) => { childError = error; });
child.once('close', (code, signal) => {
  if (childError) {
    process.stderr.write(`${childError.stack ?? childError}\n`);
    process.exitCode = 1;
  } else if (signal) {
    process.kill(process.pid, signal);
  } else {
    process.exitCode = code ?? 1;
  }
});
