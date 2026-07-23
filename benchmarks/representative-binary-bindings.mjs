import { constants, chmod, copyFile, mkdir, readFile, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';

import { sha256Hex } from './production-v2-benchmark-adapter.mjs';

const BINARY_ARMS = Object.freeze(['current-aishell-0.3.3', 'candidate']);

async function binaryDigest(file, label) {
  const metadata = await stat(file);
  if (!metadata.isFile()) throw new Error(`${label} must be a regular file`);
  return sha256Hex(await readFile(file));
}

export async function ensureRepresentativeBinaryBindings({ manifest, armBinaries, bindingsDirectory }) {
  if (!manifest || typeof manifest !== 'object' || !manifest.armBindings
    || !armBinaries || typeof armBinaries !== 'object'
    || typeof bindingsDirectory !== 'string' || !path.isAbsolute(bindingsDirectory)) {
    throw new Error('representative binary binding inputs are invalid');
  }

  const frozen = {};
  for (const arm of BINARY_ARMS) {
    const expectedDigest = manifest.armBindings[arm]?.aishellBinaryDigest;
    const source = armBinaries[arm];
    if (typeof expectedDigest !== 'string' || !/^[0-9a-f]{64}$/u.test(expectedDigest)
      || typeof source !== 'string' || !path.isAbsolute(source) || path.normalize(source) !== source) {
      throw new Error(`${arm} binary binding is invalid`);
    }

    const directory = path.join(bindingsDirectory, arm);
    const target = path.join(directory, 'aishell-mcp');
    await mkdir(directory, { recursive: true });
    try {
      const frozenDigest = await binaryDigest(target, `${arm} frozen binary`);
      if (frozenDigest !== expectedDigest) throw new Error(`${arm} frozen binary digest differs from manifest`);
      frozen[arm] = target;
      continue;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }

    const sourceDigest = await binaryDigest(source, `${arm} source binary`);
    if (sourceDigest !== expectedDigest) throw new Error(`${arm} source binary digest differs from manifest`);
    const temporary = `${target}.tmp-${process.pid}`;
    try {
      await copyFile(source, temporary, constants.COPYFILE_EXCL);
      await chmod(temporary, 0o755);
      if (await binaryDigest(temporary, `${arm} staged binary`) !== expectedDigest) {
        throw new Error(`${arm} staged binary digest differs from manifest`);
      }
      await rename(temporary, target);
    } finally {
      await rm(temporary, { force: true });
    }
    frozen[arm] = target;
  }
  return Object.freeze(frozen);
}
