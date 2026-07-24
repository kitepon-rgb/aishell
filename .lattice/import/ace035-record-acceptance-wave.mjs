import { taskRecord } from "/Users/kite/Developer/dotagents/lib/orchestrate/control-record.mjs";

const cwd = "/Users/kite/Developer/aishell";
const control_id = "aishell-capability-expansion-20260721";
const actor_id = "bell-root-20260722-ace035-acceptance";

let result = await taskRecord({
  cwd,
  control_id,
  actor_id,
  expected_revision: 133,
  task: {
    task_id: "ace035-phase3-production-acceptance-tests",
    title: "Phase 3 production境界をSwift受入testで固定する",
    classification: "F",
    effect: "write",
    doc_ref: "docs/development-efficiency-plan.md",
    role: "implementer",
    lane: "behavior-change",
    depends_on: ["ace034-static-import-impact-provider", "ace034-depfile-impact-provider"],
    validation: ["swift test --filter Phase3AcceptanceTests", "git diff --check"],
    non_goals: ["production実装を変更しない", "凍結benchmark fixtureを変更しない"],
    known_traps: ["false-freshを成功扱いしない", "未対応coverageをcompleteへ丸めない"],
    read_scope: [
      { kind: "directory", path: "Sources/AIShellCore" },
      { kind: "directory", path: "benchmarks" },
      { kind: "file", path: "docs/development-efficiency-plan.md" },
    ],
    write_scope: [{ kind: "file", path: "Tests/AIShellCoreTests/Phase3AcceptanceTests.swift" }],
    required_capabilities: ["workspace.read", "workspace.write", "report.structured"],
    isolation: "none",
    context_policy: {
      share_objective: true,
      share_current_candidate: true,
      share_existing_findings: true,
      share_failed_approaches: true,
      share_test_results: true,
    },
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
    task_id: "ace035-representative-benchmark-runner",
    title: "Phase 3の54 attemptとprovider usage gateを機械検証するrunnerを追加する",
    classification: "F",
    effect: "write",
    doc_ref: "docs/development-efficiency-plan.md",
    role: "implementer",
    lane: "behavior-change",
    depends_on: ["ace034-benchmark-v1-production-v2-adapter"],
    validation: ["node --test benchmarks/test-phase3-representative-runner.mjs", "git diff --check"],
    non_goals: ["外部model attemptを実行しない", "凍結benchmark fixtureを変更しない", "usage欠損を推計で補わない"],
    known_traps: ["6 task×3 arm×3 repetitionを欠落させない", "oracleをmodel-visible入力へ混ぜない", "provider-reported usage欠損はrun全体をinvalidにする"],
    read_scope: [{ kind: "directory", path: "benchmarks" }],
    write_scope: [
      { kind: "file", path: "benchmarks/phase3-representative-runner.mjs" },
      { kind: "file", path: "benchmarks/phase3-representative-result.schema.json" },
      { kind: "file", path: "benchmarks/test-phase3-representative-runner.mjs" },
    ],
    required_capabilities: ["workspace.read", "workspace.write", "report.structured"],
    isolation: "none",
    context_policy: {
      share_objective: true,
      share_current_candidate: true,
      share_existing_findings: true,
      share_failed_approaches: true,
      share_test_results: true,
    },
    approval: null,
    alternative_group: null,
  },
});

process.stdout.write(`${JSON.stringify({ revision: result.revision })}\n`);
