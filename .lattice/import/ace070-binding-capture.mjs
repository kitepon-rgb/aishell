import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { exchangeMCP } from '../../benchmarks/phase3-local-callbacks.mjs';
import { mcpCatalogRequestBytes, validateCatalogExchange } from '../../benchmarks/phase3-production-harness.mjs';
import { sha256Hex } from '../../benchmarks/production-v2-benchmark-adapter.mjs';

const binaries = {
  'current-aishell-0.3.3': '/private/tmp/aishell-phase3-arms.tDYCoY/current-0.3.3/.build/arm64-apple-macosx/release/aishell-mcp',
  candidate: path.resolve('build/AIShell.app/Contents/Helpers/aishell-mcp'),
};
const root = await mkdtemp(path.join(tmpdir(), 'aishell-ace070-bindings-'));
try {
  const workspace = path.join(root, 'workspace');
  await mkdir(workspace);
  const bindings = {};
  for (const [arm, binary] of Object.entries(binaries)) {
    const stateDirectory = path.join(root, arm);
    await mkdir(stateDirectory);
    await writeFile(path.join(stateDirectory, 'runtime.json'), `${JSON.stringify({
      allowedRootPaths: [workspace], isPaused: false, updatedAt: '2001-01-01T00:00:00Z',
    })}\n`, { flag: 'wx' });
    const requestBytes = mcpCatalogRequestBytes();
    const responseBytes = await exchangeMCP({
      binary,
      profile: arm === 'candidate' ? 'expanded-v1' : 'development',
      stateDirectory,
      workspace,
      requestBytes,
    });
    const catalog = validateCatalogExchange(requestBytes, responseBytes);
    bindings[arm] = {
      binary,
      aishellBinaryDigest: sha256Hex(await readFile(binary)),
      aishellToolCatalogDigest: catalog.responseSHA256,
      catalogByteLength: catalog.responseBytes.length,
    };
  }
  process.stdout.write(`${JSON.stringify({ schema: 'aishell.ace070-arm-bindings.v1', bindings }, null, 2)}\n`);
} finally {
  await rm(root, { recursive: true, force: true });
}
