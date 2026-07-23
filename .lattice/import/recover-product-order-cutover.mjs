import { createHash } from 'node:crypto';
import {
  mkdir, readFile, readdir, rename, rm, writeFile,
} from 'node:fs/promises';
import path from 'node:path';

const repoRoot = '/Users/kite/Developer/aishell';
const failedPlanVersion = 'rev-a117d2d0bec416cf7c5d47bf';
const failedRevisionDigest = '90e34aa47fad3a7efd76244d1915793d7aae59390cba0538ab6763727947a378';
const transaction = path.join(repoRoot, '.lattice/todo/transactions/phase-v3',
  'aishell-capability-expansion', failedPlanVersion);
const planDirectory = path.join(repoRoot, '.lattice/todo/plans/aishell-capability-expansion',
  failedPlanVersion);
const barrier = path.join(repoRoot, '.lattice/todo/source-cutover-recovery.json');
const source = path.join(repoRoot,
  '.lattice/todo/source-ledger/aishell-capability-expansion-cutover-20260720.md');
const archive = path.join(repoRoot,
  '.lattice/todo/source-ledger/aishell-product-order-cutover-20260723.md');
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

const manifest = JSON.parse(await readFile(path.join(repoRoot, '.lattice/todo/manifest.json')));
const active = manifest.members.find(({ plan_key: planKey }) =>
  planKey === 'aishell-capability-expansion');
if (active?.active_plan_version === failedPlanVersion) {
  throw new Error('failed revision is already active; rollback refused');
}
const barrierValue = JSON.parse(await readFile(barrier));
if (barrierValue.revision_digest !== failedRevisionDigest) throw new Error('barrier digest mismatch');
const descriptor = JSON.parse(await readFile(path.join(transaction, 'source-cutover.json')));
if (descriptor.revision_digest !== failedRevisionDigest || descriptor.files.length !== 1) {
  throw new Error('cutover descriptor mismatch');
}
const before = await readFile(path.join(transaction, descriptor.files[0].before));
const after = await readFile(path.join(transaction, descriptor.files[0].after));
const archived = await readFile(path.join(transaction, 'source-archive.bin'));
if (digest(before) !== descriptor.files[0].before_digest
  || digest(after) !== descriptor.files[0].after_digest
  || digest(archived) !== descriptor.archive_digest
  || !(await readFile(source)).equals(after)
  || !(await readFile(archive)).equals(archived)) {
  throw new Error('published cutover bytes do not match retained rollback images');
}
const failedRevision = JSON.parse(await readFile(path.join(planDirectory, 'revision.json')));
if (failedRevision.revision_digest !== failedRevisionDigest) {
  throw new Error('published failed revision digest mismatch');
}
const temporary = `${source}.rollback-${failedRevisionDigest.slice(0, 12)}`;
await writeFile(temporary, before, { flag: 'wx', mode: descriptor.files[0].mode });
await rename(temporary, source);
await rm(archive);
await rm(barrier);
await rm(planDirectory, { recursive: true });
await rm(transaction, { recursive: true });
await mkdir(path.dirname(transaction), { recursive: true });
const remaining = await readdir(path.dirname(transaction));
process.stdout.write(`${JSON.stringify({
  schema: 'aishell.product_order_cutover_recovery.v1',
  restored_source_digest: digest(await readFile(source)),
  removed_archive: path.relative(repoRoot, archive),
  removed_failed_plan_version: failedPlanVersion,
  remaining_transactions: remaining,
})}\n`);
