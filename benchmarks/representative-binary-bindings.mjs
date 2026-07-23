import {
  constants, chmod, copyFile, mkdir, readFile, rename, rm, stat, writeFile,
} from 'node:fs/promises';
import path from 'node:path';

import { sha256Hex } from './production-v2-benchmark-adapter.mjs';

const BINARY_ARMS = Object.freeze(['current-aishell-0.3.3', 'candidate']);
const RUN_SUPERVISOR = 'aishell-run-supervisor';

async function binaryDigest(file, label) {
  const metadata = await stat(file);
  if (!metadata.isFile()) throw new Error(`${label} must be a regular file`);
  return sha256Hex(await readFile(file));
}

async function optionalBinaryDigest(file, label) {
  try {
    return await binaryDigest(file, label);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

async function freezeRunSupervisor({
  arm, expectedPrimaryDigest, sourcePrimary, targetDirectory,
}) {
  const source = path.join(path.dirname(sourcePrimary), RUN_SUPERVISOR);
  const target = path.join(targetDirectory, RUN_SUPERVISOR);
  const receipt = path.join(targetDirectory, `${RUN_SUPERVISOR}.binding.json`);
  const frozenDigest = await optionalBinaryDigest(target, `${arm} frozen run supervisor`);
  if (frozenDigest) {
    let binding;
    try {
      binding = JSON.parse(await readFile(receipt, 'utf8'));
    } catch (error) {
      if (error?.code === 'ENOENT') throw new Error(`${arm} frozen run supervisor binding is missing`);
      throw error;
    }
    if (binding?.schema !== 'aishell.representative-companion-binding.v1'
      || binding.arm !== arm
      || binding.primaryBinaryDigest !== expectedPrimaryDigest
      || binding.companion !== RUN_SUPERVISOR
      || binding.companionBinaryDigest !== frozenDigest) {
      throw new Error(`${arm} frozen run supervisor binding is invalid`);
    }
    return;
  }

  const sourceDigest = await optionalBinaryDigest(source, `${arm} source run supervisor`);
  if (!sourceDigest) return;
  const sourcePrimaryDigest = await binaryDigest(sourcePrimary, `${arm} source binary`);
  if (sourcePrimaryDigest !== expectedPrimaryDigest) {
    throw new Error(`${arm} source binary differs from frozen primary while capturing run supervisor`);
  }
  const temporary = `${target}.tmp-${process.pid}`;
  const receiptTemporary = `${receipt}.tmp-${process.pid}`;
  try {
    await copyFile(source, temporary, constants.COPYFILE_EXCL);
    await chmod(temporary, 0o755);
    if (await binaryDigest(temporary, `${arm} staged run supervisor`) !== sourceDigest) {
      throw new Error(`${arm} staged run supervisor digest differs from source`);
    }
    await rename(temporary, target);
    await writeFile(receiptTemporary, `${JSON.stringify({
      schema: 'aishell.representative-companion-binding.v1',
      arm,
      primaryBinaryDigest: expectedPrimaryDigest,
      companion: RUN_SUPERVISOR,
      companionBinaryDigest: sourceDigest,
    }, null, 2)}\n`, { flag: 'wx' });
    await rename(receiptTemporary, receipt);
  } finally {
    await rm(temporary, { force: true });
    await rm(receiptTemporary, { force: true });
  }
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
    let primaryWasFrozen = false;
    try {
      const frozenDigest = await binaryDigest(target, `${arm} frozen binary`);
      if (frozenDigest !== expectedDigest) throw new Error(`${arm} frozen binary digest differs from manifest`);
      primaryWasFrozen = true;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }

    if (!primaryWasFrozen) {
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
    }
    await freezeRunSupervisor({
      arm, expectedPrimaryDigest: expectedDigest, sourcePrimary: source, targetDirectory: directory,
    });
    frozen[arm] = target;
  }
  return Object.freeze(frozen);
}
