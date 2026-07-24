import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { observeProviderModel } from '../../benchmarks/phase3-local-callbacks.mjs';

const workspace = await mkdtemp(path.join(tmpdir(), 'aishell-provider-preflight-'));
try {
  const args = [
    'exec', '--json', '--ephemeral', '--ignore-user-config', '--ignore-rules',
    '--skip-git-repo-check', '--color', 'never', '--sandbox', 'workspace-write',
    '--config', 'approval_policy="never"', '--config', 'sandbox_workspace_write.network_access=false',
    '--config', 'model_reasoning_effort="high"', '--model', 'gpt-5.6-sol', '--cd', workspace,
    'Return exactly this JSON and nothing else: {"status":"ok"}',
  ];
  const child = spawn('codex', args, { cwd: workspace, env: { ...process.env, RUST_LOG: 'tungstenite::protocol=trace' } });
  const stdout = []; const stderr = [];
  child.stdout.on('data', (chunk) => stdout.push(Buffer.from(chunk)));
  child.stderr.on('data', (chunk) => stderr.push(Buffer.from(chunk)));
  const exitCode = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  const providerTraceBytes = Buffer.concat(stdout);
  const rawStderr = Buffer.concat(stderr);
  const providerSSEBytes = Buffer.concat(rawStderr.toString('utf8').split('\n').flatMap((line) => {
    const marker = 'Received message ';
    const offset = line.indexOf(marker);
    if (offset < 0) return [];
    const bytes = Buffer.from(line.slice(offset + marker.length));
    try {
      const event = JSON.parse(bytes.toString('utf8'));
      return event?.type === 'response.created' || event?.type === 'response.completed'
        ? [bytes, Buffer.from('\n')] : [];
    } catch { return []; }
  }));
  const evidence = JSON.parse(await observeProviderModel({ providerTraceBytes, providerSSEBytes }));
  process.stdout.write(`${JSON.stringify({ exitCode, ...evidence })}\n`);
} finally {
  await rm(workspace, { recursive: true, force: true });
}
