#!/usr/bin/env node

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { ensureRepresentativeBinaryBindings } from './representative-binary-bindings.mjs';

const digest = (value) => createHash('sha256').update(value).digest('hex');
const temporary = await mkdtemp(path.join(os.tmpdir(), 'aishell-representative-bindings-'));
try {
  const currentDirectory = path.join(temporary, 'current');
  const candidateDirectory = path.join(temporary, 'candidate');
  await mkdir(currentDirectory);
  await mkdir(candidateDirectory);
  const current = path.join(currentDirectory, 'aishell-mcp');
  const candidate = path.join(candidateDirectory, 'aishell-mcp');
  await writeFile(current, 'current-binary', { mode: 0o755 });
  await writeFile(candidate, 'candidate-binary', { mode: 0o755 });
  await writeFile(path.join(candidateDirectory, 'aishell-run-supervisor'), 'candidate-supervisor', { mode: 0o755 });
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
  const frozenSupervisor = path.join(path.dirname(first.candidate), 'aishell-run-supervisor');
  assert.equal(String(await readFile(frozenSupervisor)), 'candidate-supervisor');
  const companionBinding = JSON.parse(await readFile(`${frozenSupervisor}.binding.json`, 'utf8'));
  assert.equal(companionBinding.primaryBinaryDigest, digest('candidate-binary'));
  assert.equal(companionBinding.companionBinaryDigest, digest('candidate-supervisor'));

  const lateBindings = path.join(temporary, 'late-bindings');
  await rm(path.join(candidateDirectory, 'aishell-run-supervisor'));
  await ensureRepresentativeBinaryBindings({
    manifest,
    armBinaries: { 'current-aishell-0.3.3': current, candidate },
    bindingsDirectory: lateBindings,
  });
  await writeFile(path.join(candidateDirectory, 'aishell-run-supervisor'), 'late-supervisor', { mode: 0o755 });
  await writeFile(candidate, 'drifted-before-late-companion');
  await assert.rejects(() => ensureRepresentativeBinaryBindings({
    manifest,
    armBinaries: { 'current-aishell-0.3.3': current, candidate },
    bindingsDirectory: lateBindings,
  }), /source binary differs from frozen primary while capturing run supervisor/u);
  await writeFile(candidate, 'candidate-binary', { mode: 0o755 });

  await writeFile(candidate, 'drifted-candidate');
  await writeFile(path.join(candidateDirectory, 'aishell-run-supervisor'), 'drifted-supervisor');
  const resumed = await ensureRepresentativeBinaryBindings({
    manifest,
    armBinaries: { 'current-aishell-0.3.3': current, candidate },
    bindingsDirectory,
  });
  assert.equal(resumed.candidate, first.candidate);
  assert.equal(String(await readFile(resumed.candidate)), 'candidate-binary');
  assert.equal(String(await readFile(frozenSupervisor)), 'candidate-supervisor');

  await writeFile(frozenSupervisor, 'corrupt-frozen-supervisor');
  await assert.rejects(() => ensureRepresentativeBinaryBindings({
    manifest,
    armBinaries: { 'current-aishell-0.3.3': current, candidate },
    bindingsDirectory,
  }), /frozen run supervisor binding is invalid/u);
  await writeFile(frozenSupervisor, 'candidate-supervisor');

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
