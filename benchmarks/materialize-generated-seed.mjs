#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const GENERATED_SEED_ALGORITHM = 'sha256-repeat-v1';

export function generatedSeedEntries(specification) {
  if (specification.algorithm !== GENERATED_SEED_ALGORITHM || specification.indexOrigin !== 0 || specification.encoding !== 'binary') {
    throw new Error('unsupported generated seed contract');
  }
  const entries = [];
  for (let index = 0; index < specification.fileCount; index += 1) {
    const file = specification.pathPattern.replace('%04d', String(index).padStart(4, '0'));
    const block = createHash('sha256').update(`${specification.contentSeed}:${index}`).digest();
    const bytes = Buffer.alloc(specification.bytesPerFile);
    for (let offset = 0; offset < bytes.length; offset += block.length) block.copy(bytes, offset, 0, Math.min(block.length, bytes.length - offset));
    entries.push({path:file,bytes});
  }
  return entries;
}

export function generatedTreeDigest(specification) {
  const hash = createHash('sha256');
  for (const entry of generatedSeedEntries(specification)) {
    hash.update(entry.path).update('\0').update(createHash('sha256').update(entry.bytes).digest('hex')).update('\n');
  }
  return hash.digest('hex');
}

export async function materializeGeneratedSeed(root, specification) {
  if (generatedTreeDigest(specification) !== specification.expectedTreeDigest) throw new Error('generated seed digest mismatch');
  for (const entry of generatedSeedEntries(specification)) {
    const target = path.join(root, entry.path);
    await mkdir(path.dirname(target), {recursive:true});
    await writeFile(target, entry.bytes);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.length !== 4) throw new Error('usage: materialize-generated-seed.mjs <workspace> <specification.json>');
  const specification = JSON.parse(await (await import('node:fs/promises')).readFile(process.argv[3], 'utf8'));
  await materializeGeneratedSeed(path.resolve(process.argv[2]), specification);
}
