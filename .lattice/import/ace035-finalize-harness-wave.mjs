import { taskFinalizeRecord } from "/Users/kite/Developer/dotagents/lib/orchestrate/control-record.mjs";

const cwd = "/Users/kite/Developer/aishell";
const control_id = "aishell-capability-expansion-20260721";
const actor_id = "bell-root-20260722-ace035-execution";
let revision = 139;

for (const [task_id, finalization_ref] of [
  ["ace035-phase3-production-acceptance-tests", "docs/adr/0018-run-check-invocation-plan-contract.md"],
  ["ace035-representative-benchmark-runner", "docs/adr/0012-change-impact-contract.md"],
  ["ace035-codex-attempt-executor", "docs/adr/0018-run-check-invocation-plan-contract.md"],
  ["ace035-oracle-acceptance-aggregator", "docs/adr/0012-change-impact-contract.md"],
  ["ace035-production-benchmark-harness", "docs/adr/0018-run-check-invocation-plan-contract.md"],
  ["ace035-local-production-callbacks", "docs/adr/0018-run-check-invocation-plan-contract.md"],
]) {
  const result = await taskFinalizeRecord({
    cwd, control_id, actor_id, expected_revision: revision, task_id, finalization_ref, recorded_by: actor_id,
  });
  revision = result.revision;
}

process.stdout.write(`${JSON.stringify({ revision })}\n`);
