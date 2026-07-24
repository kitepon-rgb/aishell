import { taskRecord } from "/Users/kite/Developer/dotagents/lib/orchestrate/control-record.mjs";

const cwd = "/Users/kite/Developer/aishell";
const control_id = "aishell-capability-expansion-20260721";
const actor_id = "bell-root-20260722-ace035-execution";

let result = await taskRecord({
  cwd,
  control_id,
  actor_id,
  expected_revision: 135,
  task: {
    task_id: "ace035-codex-attempt-executor",
    title: "凍結manifestをCodex CLIと3 armへ接続しraw証拠を保存する",
    classification: "F",
    effect: "write",
    doc_ref: "docs/development-efficiency-plan.md",
    role: "implementer",
    lane: "behavior-change",
    depends_on: ["ace035-representative-benchmark-runner"],
    validation: ["node --test benchmarks/test-phase3-codex-executor.mjs", "git diff --check"],
    non_goals: ["実model attemptをtest中に起動しない", "凍結fixtureやoracleを変更しない", "usageを推計しない"],
    known_traps: ["armごとのMCP差以外のhost条件を変えない", "attemptごとfresh workspace/runtime stateを使う", "raw JSONL・stderr・agent result・observer evidenceを保持する"],
    read_scope: [{ kind: "directory", path: "benchmarks" }],
    write_scope: [
      { kind: "file", path: "benchmarks/phase3-codex-executor.mjs" },
      { kind: "file", path: "benchmarks/test-phase3-codex-executor.mjs" },
    ],
    required_capabilities: ["workspace.read", "workspace.write", "process.execute", "report.structured"],
    isolation: "none",
    context_policy: { share_objective: true, share_current_candidate: true, share_existing_findings: true, share_failed_approaches: true, share_test_results: true },
    approval: null,
    alternative_group: null,
  },
});

result = await taskRecord({
  cwd,
  control_id,
  actor_id,
  expected_revision: result.revision,
  task: {
    task_id: "ace035-oracle-acceptance-aggregator",
    title: "54 attemptのoracle・correctness・tokens per solved taskをfail-closed集計する",
    classification: "F",
    effect: "write",
    doc_ref: "docs/development-efficiency-plan.md",
    role: "implementer",
    lane: "behavior-change",
    depends_on: ["ace035-representative-benchmark-runner"],
    validation: ["node --test benchmarks/test-phase3-acceptance-aggregate.mjs", "git diff --check"],
    non_goals: ["invalid attemptを置換しない", "欠損usageを0として扱わない", "oracle値をmodel-visible入力へ混ぜない"],
    known_traps: ["failed attempt tokenもnumeratorへ含める", "zero successはpositive infinity", "candidate/currentがnative解決taskを落としたら不受理"],
    read_scope: [{ kind: "directory", path: "benchmarks" }],
    write_scope: [
      { kind: "file", path: "benchmarks/phase3-acceptance-aggregate.mjs" },
      { kind: "file", path: "benchmarks/phase3-acceptance-report.schema.json" },
      { kind: "file", path: "benchmarks/test-phase3-acceptance-aggregate.mjs" },
    ],
    required_capabilities: ["workspace.read", "workspace.write", "report.structured"],
    isolation: "none",
    context_policy: { share_objective: true, share_current_candidate: true, share_existing_findings: true, share_failed_approaches: true, share_test_results: true },
    approval: null,
    alternative_group: null,
  },
});

process.stdout.write(`${JSON.stringify({ revision: result.revision })}\n`);
