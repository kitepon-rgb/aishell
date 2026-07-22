#!/usr/bin/env node

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const root = await mkdtemp(path.join(os.tmpdir(), 'aishell-phase3-wire-tap-'));
const wireDirectory = path.join(root, 'wire');
const input = Buffer.from('{"jsonrpc":"2.0","id":1,"text":"正確なbytes"}\n\0tail', 'utf8');
const tap = new URL('phase3-mcp-wire-tap.mjs', import.meta.url).pathname;

const result = await new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [tap, '/bin/cat'], {
    env: { ...process.env, AISHELL_PHASE3_MCP_WIRE_DIRECTORY: wireDirectory },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const stdout = [];
  const stderr = [];
  child.stdout.on('data', (chunk) => stdout.push(Buffer.from(chunk)));
  child.stderr.on('data', (chunk) => stderr.push(Buffer.from(chunk)));
  child.once('error', reject);
  child.once('close', (exitCode) => resolve({ exitCode, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) }));
  child.stdin.end(input);
});

assert.equal(result.exitCode, 0);
assert.deepEqual(result.stderr, Buffer.alloc(0));
assert.deepEqual(result.stdout, input);
assert.deepEqual(await readFile(path.join(wireDirectory, 'requests.bin')), input);
assert.deepEqual(await readFile(path.join(wireDirectory, 'responses.bin')), input);
await rm(root, { recursive: true, force: true });
process.stdout.write(`${JSON.stringify({ schema: 'aishell.phase3_mcp_wire_tap_self_test.v1', status: 'valid' })}\n`);
