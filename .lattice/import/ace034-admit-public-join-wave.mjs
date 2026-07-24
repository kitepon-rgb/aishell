import { admitWorker } from "/Users/kite/Developer/dotagents/lib/orchestrate/control-record.mjs";

const cwd = "/Users/kite/Developer/aishell";
const control_id = "aishell-capability-expansion-20260721";
const actor_id = "bell-root-20260722-ace034-seams";
let revision = 93;
for (const worker_run_id of [
  "ace034-public-primitives-writer-run",
  "ace034-mcp-adapter-writer-run",
]) {
  const result = await admitWorker({
    cwd,
    control_id,
    actor_id,
    expected_revision: revision,
    worker_run_id,
  });
  revision = result.revision;
}
process.stdout.write(`${JSON.stringify({ revision })}\n`);
