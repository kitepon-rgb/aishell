import fs from "node:fs";
import path from "node:path";
import {
  delegationPacketForWorker,
  workerReportSkeletonForWorker,
} from "/Users/kite/Developer/dotagents/lib/orchestrate/control-record.mjs";

const cwd = process.cwd();
const control_id = "aishell-capability-expansion-20260721";
for (const worker_run_id of [
  "ace034-public-primitives-writer-run",
  "ace034-mcp-adapter-writer-run",
]) {
  const directory = path.join(cwd, ".lattice/import/delegation", worker_run_id);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const packet = await delegationPacketForWorker({ cwd, control_id, worker_run_id });
  const skeleton = await workerReportSkeletonForWorker({ cwd, control_id, worker_run_id });
  fs.writeFileSync(path.join(directory, "delegation-packet.json"), `${JSON.stringify(packet, null, 2)}\n`, { mode: 0o600 });
  fs.writeFileSync(path.join(directory, "worker-report-skeleton.json"), `${JSON.stringify(skeleton, null, 2)}\n`, { mode: 0o600 });
}
