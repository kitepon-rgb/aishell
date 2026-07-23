#!/usr/bin/env node

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { ensureRepresentativeBinaryBindings } from './representative-binary-bindings.mjs';

const digest = (value) => createHash('sha256').update(value).digest('hex');
const temporary = await mkdtemp(path.join(os.tmpdir(), 'aishell-representative-bindings-'));
try {
  const current = path.join(temporary, 'current');
  const candidate = path.join(temporary, 'candidate');
  await writeFile(current, 'current-binary', { mode: 0o755 });
  await writeFile(candidate, 'candidate-binary', { mode: 0o755 });
  const manifest = {
    armBindings: {
      'current-aishell-0.3.3': { aishellBinaryDigest: digest('current-binary') },
      candidate: { aishellBinaryDigest: digest('candidate-binary') },
    },
  };
  const bindingsDirectory = path.join(temporary, 'bindings');
  const first = await ensureRepresentativeBinaryBindings({
    manifest,
    armBinaries: { 'current-aishell-0.3.3': current, candidate },
    bindingsDirectory,
  });
  assert.equal(String(await readFile(first['current-aishell-0.3.3'])), 'current-binary');
  assert.equal(String(await readFile(first.candidate)), 'candidate-binary');

  await writeFile(candidate, 'drifted-candidate');
  const resumed = await ensureRepresentativeBinaryBindings({
    manifest,
    armBinaries: { 'current-aishell-0.3.3': current, candidate },
    bindingsDirectory,
  });
  assert.equal(resumed.candidate, first.candidate);
  assert.equal(String(await readFile(resumed.candidate)), 'candidate-binary');

  await writeFile(resumed.candidate, 'corrupt-frozen-binary');
  await assert.rejects(() => ensureRepresentativeBinaryBindings({
    manifest,
    armBinaries: { 'current-aishell-0.3.3': current, candidate },
    bindingsDirectory,
  }), /frozen binary digest differs from manifest/u);

  await assert.rejects(() => ensureRepresentativeBinaryBindings({
    manifest,
    armBinaries: { 'current-aishell-0.3.3': current, candidate },
    bindingsDirectory: path.join(temporary, 'new-bindings'),
  }), /source binary digest differs from manifest/u);
} finally {
  await rm(temporary, { recursive: true, force: true });
}

process.stdout.write('representative binary binding tests passed\n');
