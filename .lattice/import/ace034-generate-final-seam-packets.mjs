import fs from "node:fs";
import path from "node:path";
import {
  delegationPacketForWorker,
  workerReportSkeletonForWorker,
} from "/Users/kite/Developer/dotagents/lib/orchestrate/control-record.mjs";

const cwd = "/Users/kite/Developer/aishell";
const control_id = "aishell-capability-expansion-20260721";
for (const worker_run_id of ["ace034-impact-continuation-retry2-run"]) {
  const directory = path.join(cwd, ".lattice/import/delegation", worker_run_id);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    path.join(directory, "delegation-packet.json"),
    `${JSON.stringify(await delegationPacketForWorker({ cwd, control_id, worker_run_id }), null, 2)}\n`,
    { mode: 0o600 },
  );
  fs.writeFileSync(
    path.join(directory, "worker-report-skeleton.json"),
    `${JSON.stringify(await workerReportSkeletonForWorker({ cwd, control_id, worker_run_id }), null, 2)}\n`,
    { mode: 0o600 },
  );
}
