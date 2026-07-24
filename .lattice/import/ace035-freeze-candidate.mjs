import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { exchangeMCP } from '../../benchmarks/phase3-local-callbacks.mjs';
import { mcpCatalogRequestBytes, validateCatalogExchange } from '../../benchmarks/phase3-production-harness.mjs';
import { sha256Hex } from '../../benchmarks/production-v2-benchmark-adapter.mjs';

const root = await mkdtemp(path.join(tmpdir(), 'aishell-ace035-freeze-'));
try {
  const workspace = path.join(root, 'workspace');
  const stateDirectory = path.join(root, 'state');
  await Promise.all([mkdir(workspace), mkdir(stateDirectory)]);
  await writeFile(path.join(stateDirectory, 'runtime.json'), `${JSON.stringify({
    allowedRootPaths: [workspace], isPaused: false, updatedAt: '2001-01-01T00:00:00Z',
  })}\n`);
  const binary = path.resolve('build/AIShell.app/Contents/Helpers/aishell-mcp');
  process.env.AISHELL_PHASE3_MCP_TIMEOUT_MS = '30000';
  const requestBytes = mcpCatalogRequestBytes();
  const responseBytes = await exchangeMCP({ binary, profile: 'expanded-v1', stateDirectory, workspace, requestBytes });
  const exchange = validateCatalogExchange(requestBytes, responseBytes);
  const messages = responseBytes.toString('utf8').trim().split('\n').map(JSON.parse);
  const tools = messages.find(({ id }) => id === 2).result.tools;
  process.stdout.write(`${JSON.stringify({
    binary, binarySHA256: sha256Hex(await readFile(binary)),
    catalogSHA256: exchange.responseSHA256, toolCount: tools.length,
    toolNames: tools.map(({ name }) => name),
  })}\n`);
} finally {
  await rm(root, { recursive: true, force: true });
}
