#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { captureManifest } from './capture-workspace-manifest.mjs';
import { materializeRequestContract } from './materialize-capability-request.mjs';

const here = new URL('.', import.meta.url);

async function optionalJSON(file, fallback = {}) {
  if (!file) return fallback;
  try { return JSON.parse(await readFile(file, 'utf8')); } catch (error) {
    if (error?.code === 'ENOENT') return fallback;
    throw error;
  }
}

async function requiredManifest(file, root) {
  const manifest = JSON.parse(await readFile(file, 'utf8'));
  if (manifest.schema !== 'aishell.workspace-manifest.v1' || manifest.root !== path.resolve(root)
    || !manifest.files || typeof manifest.files !== 'object' || Array.isArray(manifest.files)
    || manifest.fileCount !== Object.keys(manifest.files).length || manifest.fileCount < 1) {
    throw new Error('invalid baseline manifest');
  }
  const digest = createHash('sha256');
  for (const [name, sha256] of Object.entries(manifest.files).sort(([left], [right]) => left.localeCompare(right))) {
    if (!/^[a-f0-9]{64}$/u.test(sha256)) throw new Error('invalid baseline manifest');
    digest.update(name).update('\0').update(sha256).update('\n');
  }
  if (digest.digest('hex') !== manifest.digest) throw new Error('invalid baseline manifest digest');
  return manifest;
}

async function exists(file) {
  try { await stat(file); return true; } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

function changedPaths(before, after) {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter((key) => before[key] !== after[key]).sort();
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

function isSubset(expected, actual) {
  if (Array.isArray(expected)) return Array.isArray(actual) && canonical(expected) === canonical(actual);
  if (expected && typeof expected === 'object') return actual && typeof actual === 'object'
    && Object.entries(expected).every(([key, value]) => isSubset(value, actual[key]));
  return Object.is(expected, actual);
}

async function requiredRequestContract(file, taskId, root, preAttemptManifest, requiredInvocations, expectedContract, execution) {
  const contract = JSON.parse(await readFile(file, 'utf8'));
  if (contract.schema !== 'aishell.capability-request-contract.v1' || contract.taskId !== taskId
    || contract.workspaceRoot !== root || contract.preStateDigest !== preAttemptManifest.digest
    || !Array.isArray(contract.requiredCalls)) throw new Error('invalid request contract');
  const calls = contract.requiredCalls.map(({tool,action}) => `${tool}:${action}`).sort();
  if (canonical(contract) !== canonical(expectedContract) || canonical(calls) !== canonical(requiredInvocations)
    || contract.requiredCalls.some(({tool,action,templateId,requestSubset}) => {
      const expectedTemplate = execution.candidateRequestTemplateByTask[taskId]?.[tool];
      const expectedFields = execution.requestTemplates[expectedTemplate] ?? [];
      if (templateId !== expectedTemplate || !requestSubset || typeof requestSubset !== 'object' || Array.isArray(requestSubset)
        || requestSubset.action !== action || canonical(Object.keys(requestSubset).sort()) !== canonical([...expectedFields].sort())) return true;
      if ('path' in requestSubset && requestSubset.path !== root) return true;
      return Object.entries(requestSubset).some(([key,value]) => key !== 'action'
        && (value === null || value === '' || (Array.isArray(value) && value.length === 0)));
    })) {
    throw new Error('invalid request contract calls');
  }
  return contract;
}

function projectToolResult(expected, raw, exemptKeys) {
  const projected = {};
  for (const key of Object.keys(expected)) {
    if (exemptKeys.has(key)) continue;
    if (key === 'mustContainFiles') {
      const paths = new Set((raw.entries ?? []).map(({path}) => path));
      projected[key] = expected[key].filter((path) => paths.has(path));
    }
    else if (key === 'changedPaths') projected[key] = (raw.changes ?? []).map(({path}) => path);
    else if (key === 'renames') projected[key] = (raw.changes ?? []).filter(({kind}) => kind === 'renamed').map(({previousPath,path}) => [previousPath,path]);
    else if (key === 'dirty') projected[key] = raw.gitStatusState === 'dirty';
    else if (key === 'apply') projected[key] = raw.appliedChanges;
    else if (key === 'matchRuns') projected[key] = (raw.matches ?? []).map(({runId}) => runId);
    else if (key === 'pattern') projected[key] = raw.query;
    else if (key === 'added') projected[key] = raw.comparison?.added;
    else if (key === 'removed') projected[key] = raw.comparison?.removed;
    else if (key === 'rawEvidenceRetained') projected[key] = (raw.artifacts ?? []).length > 0 && raw.artifacts.every(({handle}) => typeof handle === 'string');
    else if (key === 'deduplicated') projected[key] = new Set((raw.matches ?? []).map(canonical)).size === (raw.matches ?? []).length;
    else if (key === 'provenanceRequired') projected[key] = typeof raw.provenance === 'string' && raw.provenance.length > 0;
    else if (key === 'budgeted') projected[key] = Number.isFinite(raw.returnedBytes) && Number.isFinite(raw.byteBudget) && raw.returnedBytes <= raw.byteBudget;
    else projected[key] = raw[key];
  }
  return projected;
}

async function retainedArtifacts(directory) {
  if (!directory) throw new Error('artifact store is required for artifact assertions');
  const root = path.resolve(directory);
  const manifest = JSON.parse(await readFile(path.join(root, 'manifest.json'), 'utf8'));
  if (manifest.schema !== 'aishell.retained-artifact-manifest.v1' || !Array.isArray(manifest.artifacts)) throw new Error('invalid artifact manifest');
  const runs = new Map();
  const handles = new Set();
  for (const item of manifest.artifacts) {
    if (!/^art_[a-z0-9_-]+$/u.test(item.handle) || typeof item.runId !== 'string' || typeof item.file !== 'string') throw new Error('invalid artifact record');
    const file = path.resolve(root, item.file);
    if (!file.startsWith(`${root}${path.sep}`)) throw new Error('artifact path escapes store');
    const bytes = await readFile(file);
    if (createHash('sha256').update(bytes).digest('hex') !== item.sha256) throw new Error('artifact digest mismatch');
    if (handles.has(item.handle)) throw new Error('duplicate artifact handle');
    handles.add(item.handle);
    runs.set(item.runId, bytes.toString('utf8'));
  }
  return {runs, handles:[...handles].sort()};
}

async function continuationGroundTruth(taskId, root, baseline, current) {
  if (taskId === 'batch-context-shared-budget') {
    const matches = [];
    for (const file of Object.keys(current).sort()) {
      if ((await readFile(path.join(root, file))).includes(Buffer.from('needle'))) matches.push(file);
    }
    return matches;
  }
  if (taskId === 'git-diff-context-mixed-state') return changedPaths(baseline, current);
  throw new Error(`no continuation ground truth extractor: ${taskId}`);
}

export async function observeAttempt({ taskId, armId, workspace, baselineFile, preAttemptFile, setupEvidenceFile, requestContractFile, resultFile, processFile, artifactStore, telemetryFile, traceFile, toolTraceFile, agentReportFile }) {
  const suite = JSON.parse(await readFile(new URL('representative-suite.v1.json', here)));
  const catalog = JSON.parse(await readFile(new URL('capability-fixtures.v1.json', here)));
  const execution = JSON.parse(await readFile(new URL('representative-execution-contracts.v1.json', here)));
  const task = suite.tasks.find(({ id }) => id === taskId);
  if (!task) throw new Error(`unknown task: ${taskId}`);
  if (!suite.arms.some(({ id }) => id === armId)) throw new Error(`unknown arm: ${armId}`);
  const expected = catalog.fixtures.find(({ id }) => id === task.fixture).scenarios[task.scenario].oracle;
  const root = path.resolve(workspace);
  const baselineRequired = Object.keys(expected).some((key) => ['changedPaths','renames','unchangedPaths','dirty'].includes(key))
    || (taskId === 'git-diff-context-mixed-state' && Object.hasOwn(expected, 'continuationIntegrity'));
  if (baselineRequired && !baselineFile) throw new Error(`baseline manifest required: ${taskId}`);
  const baselineManifest = baselineRequired ? await requiredManifest(baselineFile, root) : null;
  const baseline = baselineManifest?.files ?? {};
  const currentManifest = await captureManifest(root);
  const current = currentManifest.files;
  const fallbackStructured = await optionalJSON(resultFile);
  const process = await optionalJSON(processFile);
  const telemetry = await optionalJSON(telemetryFile);
  const trace = await optionalJSON(traceFile);
  const toolTrace = await optionalJSON(toolTraceFile, {events:[]});
  const agentReport = await optionalJSON(agentReportFile);
  const internalKeys = new Set(suite.metrics.internalTelemetryKeys);
  const functionalKeys = Object.keys(expected).filter((key) => !internalKeys.has(key)).sort();
  const reportedKeys = agentReport?.assertions && typeof agentReport.assertions === 'object' && !Array.isArray(agentReport.assertions)
    ? Object.keys(agentReport.assertions) : [];
  if (agentReport.schema !== 'aishell.agent-benchmark-report.v1' || agentReport.taskId !== taskId
    || !agentReport.assertions || typeof agentReport.assertions !== 'object' || Array.isArray(agentReport.assertions)
    || functionalKeys.some((key) => !reportedKeys.includes(key))) {
    throw new Error(`invalid agent report: ${taskId}`);
  }
  if (!Array.isArray(toolTrace.events)) throw new Error('invalid tool trace');
  const requiredInvocations = Object.entries(execution.candidateRequiredActionsByTask[taskId])
    .map(([tool, action]) => `${tool}:${action}`).sort();
  if (!preAttemptFile || !setupEvidenceFile || !requestContractFile) throw new Error(`pre-attempt evidence required: ${taskId}`);
  const preAttemptManifest = await requiredManifest(preAttemptFile, root);
  const setupEvidence = JSON.parse(await readFile(setupEvidenceFile, 'utf8'));
  const expectedRequestContract = materializeRequestContract({taskId, workspaceRoot:root, preAttemptManifest,
    baselineManifest, setupEvidence, suite, catalog, execution});
  const requestContract = await requiredRequestContract(requestContractFile, taskId, root, preAttemptManifest, requiredInvocations, expectedRequestContract, execution);
  const artifactEvidence = task.fixture === 'artifact-query' ? await retainedArtifacts(artifactStore) : null;
  if (artifactEvidence && canonical([...(setupEvidence.handles ?? [])].sort()) !== canonical(artifactEvidence.handles)) {
    throw new Error('setup artifact handles do not match retained store');
  }
  const expectedError = execution.candidateExpectedErrorByTask[taskId];
  const acceptedEvents = toolTrace.events
    .filter((event) => {
      if (event?.provider !== 'aishell' || typeof event.tool !== 'string' || typeof event.action !== 'string'
        || event.metadata?.preStateDigest !== preAttemptManifest.digest
        || !event.result || typeof event.result !== 'object'
        || createHash('sha256').update(canonical(event.result)).digest('hex') !== event.resultDigest) return false;
      const call = requestContract.requiredCalls.find(({tool,action}) => tool === event.tool && action === event.action);
      if (!call || !isSubset(call.requestSubset, event.request)) return false;
      if (task.fixture === 'async-process' && event.tool === 'run_check' && event.result.runId !== setupEvidence.runId) return false;
      if (expectedError) {
        return event.status === 'failed' && event.isError === true
          && event.result.schemaVersion === 'aishell.error.v1' && event.result.error?.code === expectedError;
      }
      return event.status === 'succeeded' && event.isError === false
        && event.result.schemaVersion === execution.candidateResultSchemaByTool[event.tool];
    });
  const acceptedInvocations = [...new Set(acceptedEvents.map((event) => `${event.tool}:${event.action}`))].sort();
  const structured = armId === 'candidate'
    ? (expectedError
      ? {errorCode:expectedError}
      : Object.assign({}, ...acceptedEvents.map(({result}) => result)))
    : fallbackStructured;
  const toolResultAssertions = armId === 'candidate'
    ? projectToolResult(expectedError ? {errorCode:expectedError} : expected, structured, new Set(execution.toolResultProjection.exemptKeys))
    : {};
  const sourceForKey = new Map(Object.entries(execution.observerSources).flatMap(([source, keys]) => keys.map((key) => [key, source])));
  const assertions = {};
  const observationSources = {};
  for (const [key, value] of Object.entries(expected)) {
    const source = sourceForKey.get(key);
    if (source === 'filesystem_or_git') {
      if (key === 'mustContainFiles') {
        assertions[key] = [];
        for (const file of value) if (await exists(path.join(root, file))) assertions[key].push(file);
      }
      else if (key === 'changedPaths') assertions[key] = changedPaths(baseline, current);
      else if (key === 'unchangedPaths') assertions[key] = value.filter((file) => baseline[file] !== undefined && baseline[file] === current[file]);
      else if (key === 'renames') {
        const deleted = Object.keys(baseline).filter((file) => current[file] === undefined);
        const created = Object.keys(current).filter((file) => baseline[file] === undefined);
        assertions[key] = deleted.flatMap((oldPath) => created.filter((newPath) => baseline[oldPath] === current[newPath]).map((newPath) => [oldPath, newPath]));
      }
      else if (key === 'dirty') assertions[key] = changedPaths(baseline, current).length > 0;
      else if (key === 'apply') {
        const applied = [];
        for (const [file, content] of value) {
          if (await exists(path.join(root, file)) && await readFile(path.join(root, file), 'utf8') === content) applied.push([file, content]);
        }
        assertions[key] = applied;
      }
      else assertions[key] = structured[key];
    } else if (source === 'process_supervisor') {
      assertions[key] = process[key];
    } else if (source === 'artifact_store') {
      const runs = artifactEvidence.runs;
      const first = runs.get('run-1') ?? '';
      const second = runs.get('run-2') ?? '';
      if (key === 'matchRuns') assertions[key] = value.filter((run) => (runs.get(run) ?? '').includes(expected.pattern));
      else if (key === 'pattern') assertions[key] = first.includes(value) || second.includes(value) ? value : null;
      else if (key === 'added') assertions[key] = [...new Set(second.trim().split('\n'))].filter((line) => line && !new Set(first.trim().split('\n')).has(line));
      else if (key === 'removed') assertions[key] = [...new Set(first.trim().split('\n'))].filter((line) => line && !new Set(second.trim().split('\n')).has(line));
      else if (key === 'rawEvidenceRetained') assertions[key] = runs.has('run-1') && runs.has('run-2');
    } else if (source === 'aishell_telemetry') {
      if (telemetry[key] !== undefined) assertions[key] = telemetry[key];
      else continue;
    } else if (source === 'continuation_trace') {
      if (key === 'continuationIntegrity') {
        const flattened = (trace.pages ?? []).flatMap(({items}) => items ?? []);
        const groundTruth = await continuationGroundTruth(taskId, root, baseline, current);
        assertions[key] = new Set(flattened).size === flattened.length
          && flattened.length === groundTruth.length
          && groundTruth.every((item) => flattened.includes(item));
      } else if (key === 'freshness') {
        assertions[key] = trace.indexCursor === trace.currentCursor ? 'fresh' : 'stale';
      }
    } else if (source === 'benchmark_contract') {
      if (key === 'language') assertions[key] = taskId.endsWith('-english') ? 'en' : 'ja';
      else if (key === 'requiredCapability') {
        const capabilityByTool = {workspace_wait:'workspace_wait',apply_change_set:'transactional_change_set'};
        assertions[key] = acceptedEvents.map(({tool}) => capabilityByTool[tool]).find(Boolean);
      }
    } else {
      if (key === 'deduplicated') assertions[key] = new Set(structured.matches ?? []).size === (structured.matches ?? []).length;
      else if (key === 'provenanceRequired') assertions[key] = typeof structured.provenance === 'string' && structured.provenance.length > 0;
      else if (key === 'budgeted') assertions[key] = Number.isFinite(structured.returnedBytes) && Number.isFinite(structured.byteBudget) && structured.returnedBytes <= structured.byteBudget;
      else assertions[key] = structured[key];
    }
    observationSources[key] = source;
  }
  return {
    producer:'aishell-benchmark-observer.v1',
    taskId,
    arm:armId,
    agent:{exitCode:process.agentExitCode,timedOut:process.agentTimedOut},
    assertions,
    observationSources,
    capabilityEvidence:{requiredInvocations,acceptedInvocations},
    agentReport,
    toolResultAssertions,
  };
}

async function main() {
  const args = {};
  for (let index = 2; index < process.argv.length; index += 2) args[process.argv[index].slice(2)] = process.argv[index + 1];
  if (!args.task || !args.arm || !args.workspace) {
    throw new Error('usage: observe-capability-attempt.mjs --task <id> --arm <id> --workspace <dir> --pre-attempt <manifest.json> --setup-evidence <json> --request-contract <json> [--baseline <json>] [--result <json>] [--process <json>] [--artifact-store <dir>] [--telemetry <json>] [--trace <json>] [--tool-trace <json>] [--agent-report <json>]');
  }
  process.stdout.write(`${JSON.stringify(await observeAttempt({
    taskId:args.task, armId:args.arm, workspace:args.workspace, baselineFile:args.baseline,
    resultFile:args.result, processFile:args.process, artifactStore:args['artifact-store'], telemetryFile:args.telemetry, traceFile:args.trace, toolTraceFile:args['tool-trace'], agentReportFile:args['agent-report'], preAttemptFile:args['pre-attempt'], setupEvidenceFile:args['setup-evidence'], requestContractFile:args['request-contract'],
  }))}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
