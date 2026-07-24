import { createHash } from 'node:crypto';
import { observeWorker } from '/Users/kite/Developer/dotagents/lib/orchestrate/control-record.mjs';

const observed_at = new Date().toISOString();
const ref = 'agents.followup_task:/root/ace035_wire_refuter#ace035-provider-wire-refuter-run';
const result = await observeWorker({
  cwd: '/Users/kite/Developer/aishell', control_id: 'aishell-capability-expansion-20260721',
  actor_id: 'bell-root-20260722-ace035-provider-wire', expected_revision: 149,
  worker_run_id: 'ace035-provider-wire-refuter-run',
  observation: {
    state: 'dispatched', source: 'codex-native', observed_version: 'gpt-5.6-sol high', observed_at,
    raw_state: 'native refuter follow-up dispatched', executor_handle: { agent_path: '/root/ace035_wire_refuter' },
    dispatch_evidence: [{ type: 'executor-receipt', ref, digest: createHash('sha256').update(ref).digest('hex'), observed_at }],
  },
});
process.stdout.write(`${JSON.stringify({ revision: result.revision })}\n`);
