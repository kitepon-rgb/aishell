import path from 'node:path';

import { canonicalJSONBytes, sha256Hex } from './production-v2-benchmark-adapter.mjs';

const TASKS = new Set([
  'batch-context-multi-query',
  'async-process-first-useful-result',
  'async-process-cancel',
  'workspace-wait-external-edit',
  'workspace-wait-event-gap',
]);

function exactInput({ taskId, fixtureRoot, setupCursor }) {
  if (!TASKS.has(taskId)) throw new Error(`unknown benchmark v2 task: ${taskId}`);
  if (typeof fixtureRoot !== 'string' || !path.isAbsolute(fixtureRoot) || path.normalize(fixtureRoot) !== fixtureRoot) {
    throw new Error('fixtureRoot must be a normalized absolute path');
  }
  if (typeof setupCursor !== 'string' || setupCursor.length === 0) throw new Error('setupCursor is required');
}

function runCheckStart(fixtureRoot, taskId) {
  return {
    schema: 'aishell.managed-process-benchmark-request.v2',
    start: {
      tool: 'run_check',
      arguments: {
        schema: 'aishell.run-check.v2',
        invocation: {
          mode: 'direct', executable: 'node', arguments: ['slow.mjs'],
          working_directory: fixtureRoot, environment: {},
        },
        dispatch: { mode: 'start', client_run_key: `benchmark-v2-${taskId}` },
        cache: 'off',
        execution_policy: { timeout_ms: 15000, retention_seconds: 3600 },
        selection: { binding: 'prepare' },
      },
    },
    observe: taskId === 'async-process-cancel' ? [
      { tool: 'run_observe', bind: { run_handle: 'start.result.run_handle' }, arguments: { action: 'wait', timeout_ms: 2000 } },
      { tool: 'run_observe', bind: { run_handle: 'start.result.run_handle' }, arguments: { action: 'cancel' } },
      { tool: 'run_observe', bind: { run_handle: 'start.result.run_handle' }, arguments: { action: 'wait', timeout_ms: 15000 } },
    ] : [
      { tool: 'run_observe', bind: { run_handle: 'start.result.run_handle' }, arguments: { action: 'wait', timeout_ms: 2000 } },
      { tool: 'run_observe', bind: { run_handle: 'start.result.run_handle' }, arguments: { action: 'wait', timeout_ms: 15000 } },
    ],
  };
}

export function materializeCapabilityRequestV2(input) {
  exactInput(input);
  const { taskId, fixtureRoot, setupCursor } = input;
  let request;
  switch (taskId) {
  case 'batch-context-multi-query':
    request = {
      action: 'search', path: fixtureRoot,
      queries: [
        { id: 'fixed-needle', kind: 'fixed', pattern: 'needle', case: 'sensitive', before_lines: 0, after_lines: 0 },
        { id: 'regex-export', kind: 'regex', pattern: 'export\\s+const', case: 'sensitive', before_lines: 0, after_lines: 0 },
        { id: 'glob-src', kind: 'glob', pattern: 'src/**' },
        { id: 'glob-test', kind: 'glob', pattern: 'test/**' },
      ],
      ranking: ['changed', 'tests'], changed_since_cursor: setupCursor,
      max_results: 500, byte_budget: 65536,
    };
    break;
  case 'async-process-first-useful-result':
  case 'async-process-cancel':
    request = runCheckStart(fixtureRoot, taskId);
    break;
  case 'workspace-wait-external-edit':
  case 'workspace-wait-event-gap':
    request = {
      path: fixtureRoot, from_cursor: setupCursor, timeout_ms: 5000,
    };
    break;
  default: throw new Error(`unhandled benchmark v2 task: ${taskId}`);
  }
  const bytes = canonicalJSONBytes(request);
  return { request, bytes, sha256: sha256Hex(bytes) };
}
