#!/usr/bin/env node

// Deterministically re-derive run/result.json from the frozen checkpoint under the current
// acceptance rules, WITHOUT re-executing any attempt. The checkpoint (records + oracle + metric)
// is the canonical evidence; this script only re-runs the pure assembleRepresentativeResult
// projection and records an audit receipt (before/after SHA-256, status transition, and the
// oracle-backed justification for every candidate attempt whose adapter trace is null).
//
// It refuses to run if the checkpoint records are not byte-identical to the existing result
// attempts, so it can never silently alter primary evidence — only the derived status and
// invalidReasons may change.

import { readFile, rename, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  assembleRepresentativeResult,
  validateRepresentativeAttemptManifest,
  validateRepresentativeResult,
} from './representative-production-runner.mjs';

function sha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function serialize(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

async function atomicWrite(file, text) {
  const temporary = `${file}.tmp`;
  await writeFile(temporary, text);
  await rename(temporary, file);
}

export async function reassembleRepresentativeResult({ runDirectory, write = false }) {
  const manifestFile = path.join(runDirectory, 'manifest.json');
  const checkpointFile = path.join(runDirectory, 'checkpoint.json');
  const resultFile = path.join(runDirectory, 'result.json');
  const oracleFile = path.join(runDirectory, 'oracle-records.json');

  const manifestBytes = await readFile(manifestFile);
  const checkpointBytes = await readFile(checkpointFile);
  const priorResultBytes = await readFile(resultFile);
  const oracleBytes = await readFile(oracleFile);

  const manifest = validateRepresentativeAttemptManifest(JSON.parse(manifestBytes.toString('utf8')));
  const checkpoint = JSON.parse(checkpointBytes.toString('utf8'));
  const priorResult = JSON.parse(priorResultBytes.toString('utf8'));
  const oracleRecords = JSON.parse(oracleBytes.toString('utf8'));

  if (checkpoint.schema !== 'aishell.representative-checkpoint.v1' || !Array.isArray(checkpoint.records)
    || checkpoint.records.length !== 288) {
    throw new Error('checkpoint is not a complete 288-record representative checkpoint');
  }
  // The checkpoint records are the canonical evidence. Refuse to proceed unless they are byte-identical
  // to the existing result attempts, so this re-derivation can never mutate primary evidence.
  if (JSON.stringify(checkpoint.records) !== JSON.stringify(priorResult.attempts)) {
    throw new Error('checkpoint records differ from existing result attempts; refusing to re-derive');
  }

  const reassembled = assembleRepresentativeResult(manifest, checkpoint.records);
  if (JSON.stringify(reassembled.attempts) !== JSON.stringify(checkpoint.records)) {
    throw new Error('re-derived attempts differ from checkpoint records; evidence would be altered');
  }
  const validation = validateRepresentativeResult(reassembled, manifest);
  if (!validation.valid && reassembled.status !== 'invalid') {
    throw new Error(`re-derived result is internally inconsistent: ${validation.reasons.join('; ')}`);
  }

  const oracleBySequence = new Map(oracleRecords.map((record) => [record.sequence, record.result]));
  const nullTraceCandidates = reassembled.attempts
    .filter((attempt) => attempt.arm === 'candidate' && attempt.adapterTrace === null)
    .map((attempt) => {
      const oracle = oracleBySequence.get(attempt.sequence) ?? null;
      return {
        sequence: attempt.sequence,
        attemptID: attempt.attemptID,
        taskID: attempt.taskID,
        oracleSolved: oracle ? oracle.solved : null,
        oracleFailures: oracle ? oracle.failures : null,
        // A null trace is only admissible on a non-solving candidate; the aggregate enforces this.
        admissible: Boolean(oracle && oracle.solved === false),
      };
    });

  const newResultText = serialize(reassembled);
  const receipt = {
    schema: 'aishell.representative-result-reassembly-receipt.v1',
    generatedBy: 'benchmarks/reassemble-representative-result.mjs',
    runDirectory: path.relative(process.cwd(), runDirectory) || '.',
    manifestSHA256: sha256Hex(manifestBytes),
    manifestBindingSHA256: reassembled.manifestSHA256,
    checkpointSHA256: sha256Hex(checkpointBytes),
    priorResultSHA256: sha256Hex(priorResultBytes),
    reassembledResultSHA256: sha256Hex(Buffer.from(newResultText, 'utf8')),
    attemptsUnchanged: true,
    statusTransition: { from: priorResult.status, to: reassembled.status },
    invalidReasonsBefore: priorResult.invalidReasons,
    invalidReasonsAfter: reassembled.invalidReasons,
    nullTraceCandidates,
  };
  if (write) {
    await atomicWrite(resultFile, newResultText);
    await atomicWrite(path.join(runDirectory, 'result-reassembly-receipt.json'), serialize(receipt));
  }
  return { receipt, wrote: write };
}

async function main() {
  const runDirectory = process.argv[2] ? path.resolve(process.argv[2]) : null;
  const write = process.argv.includes('--write');
  if (!runDirectory) throw new Error('usage: reassemble-representative-result.mjs <run-directory> [--write]');
  const { receipt, wrote } = await reassembleRepresentativeResult({ runDirectory, write });
  process.stdout.write(`${JSON.stringify({ wrote, ...receipt }, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
