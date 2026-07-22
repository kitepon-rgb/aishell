#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

function requiredAbsolute(value, label) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || path.normalize(value) !== value || value.includes('\0')) {
    throw new Error(`${label} must be a normalized absolute path`);
  }
  return value;
}

function finish(stream) {
  return new Promise((resolve, reject) => {
    stream.once('finish', resolve);
    stream.once('error', reject);
  });
}

async function main() {
  const target = requiredAbsolute(process.argv[2], 'AIShell MCP target');
  if (process.argv.length !== 3) throw new Error('phase3 MCP wire tap accepts exactly one target');
  const directory = requiredAbsolute(process.env.AISHELL_PHASE3_MCP_WIRE_DIRECTORY, 'wire directory');
  await mkdir(directory, { recursive: false });
  const requests = createWriteStream(path.join(directory, 'requests.bin'), { flags: 'wx' });
  const responses = createWriteStream(path.join(directory, 'responses.bin'), { flags: 'wx' });
  const requestFinished = finish(requests);
  const responseFinished = finish(responses);
  const childEnvironment = { ...process.env };
  delete childEnvironment.AISHELL_PHASE3_MCP_WIRE_DIRECTORY;
  const child = spawn(target, [], { env: childEnvironment, stdio: ['pipe', 'pipe', 'pipe'] });

  process.stdin.on('data', (chunk) => requests.write(chunk));
  process.stdin.pipe(child.stdin);
  child.stdout.on('data', (chunk) => responses.write(chunk));
  child.stdout.pipe(process.stdout);
  child.stderr.pipe(process.stderr);

  let childError = null;
  child.once('error', (error) => { childError = error; });
  const exit = await new Promise((resolve) => child.once('close', (code, signal) => resolve({ code, signal })));
  requests.end();
  responses.end();
  await Promise.all([requestFinished, responseFinished]);
  if (childError) throw childError;
  if (exit.signal) {
    process.kill(process.pid, exit.signal);
    return;
  }
  process.exitCode = exit.code ?? 1;
}

main().catch((error) => {
  process.stderr.write(`${error?.stack ?? error}\n`);
  process.exitCode = 1;
});
