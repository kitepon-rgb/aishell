import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { captureTrustedSetup, runSetupStep } from '../../benchmarks/phase3-local-callbacks.mjs';
import { sha256Hex } from '../../benchmarks/production-v2-benchmark-adapter.mjs';

const root = await mkdtemp(path.join(tmpdir(), 'aishell-ace035-profile-preflight-'));
try {
  const workspace = path.join(root, 'workspace');
  const stateDirectory = path.join(root, 'state');
  await Promise.all([mkdir(workspace), mkdir(stateDirectory)]);
  const catalog = JSON.parse(await readFile(new URL('../../benchmarks/capability-fixtures.v1.json', import.meta.url), 'utf8'));
  const fixture = catalog.fixtures.find(({ id }) => id === 'freshness-cache');
  for (const [relative, content] of Object.entries(fixture.seedFiles)) {
    const target = path.join(workspace, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content, { flag: 'wx' });
  }
  await writeFile(path.join(stateDirectory, 'runtime.json'), `${JSON.stringify({
    allowedRootPaths: [workspace], isPaused: false, updatedAt: '2001-01-01T00:00:00Z',
  })}\n`, { flag: 'wx' });

  const binary = path.resolve('build/AIShell.app/Contents/Helpers/aishell-mcp');
  process.env.AISHELL_PHASE3_CANDIDATE_BINARY = binary;
  process.env.AISHELL_PHASE3_MCP_TIMEOUT_MS = '30000';
  process.env.AISHELL_PHASE3_SETUP_TIMEOUT_MS = '30000';
  const attempt = { attemptID: 'ace035-production-profile-preflight', taskID: 'freshness-cache-repeat-check', arm: 'candidate', repetition: 1 };
  const armBinding = { aishellBinaryDigest: sha256Hex(await readFile(binary)) };
  const trusted = await captureTrustedSetup({ attempt, armBinding, workspace, stateDirectory });
  const warm = await runSetupStep({
    attempt, armBinding, workspace, stateDirectory,
    step: 'execute the check once and retain its freshness inputs',
  });
  process.stdout.write(`${JSON.stringify({ schema: 'aishell.ace035-production-profile-preflight.v1', trusted, warm, status: 'valid' })}\n`);
} finally {
  await rm(root, { recursive: true, force: true });
}
