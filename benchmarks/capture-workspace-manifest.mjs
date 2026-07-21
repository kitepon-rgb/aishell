#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export async function captureManifest(root) {
  const files = {};
  async function walk(relative = '') {
    const absolute = path.join(root, relative);
    for (const entry of await readdir(absolute, { withFileTypes: true })) {
      if (entry.name === '.git') continue;
      const child = path.join(relative, entry.name);
      if (entry.isDirectory()) await walk(child);
      if (entry.isFile()) {
        files[child.split(path.sep).join('/')] = createHash('sha256')
          .update(await readFile(path.join(root, child))).digest('hex');
      }
    }
  }
  await walk();
  const digest = createHash('sha256');
  for (const [file, sha256] of Object.entries(files).sort(([left], [right]) => left.localeCompare(right))) {
    digest.update(file).update('\0').update(sha256).update('\n');
  }
  return {schema:'aishell.workspace-manifest.v1',root:path.resolve(root),fileCount:Object.keys(files).length,files,digest:digest.digest('hex')};
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.length !== 3) throw new Error('usage: capture-workspace-manifest.mjs <workspace>');
  process.stdout.write(`${JSON.stringify(await captureManifest(path.resolve(process.argv[2])))}\n`);
}
