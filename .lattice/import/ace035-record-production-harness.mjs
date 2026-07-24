import { taskRecord } from "/Users/kite/Developer/dotagents/lib/orchestrate/control-record.mjs";

const result = await taskRecord({
  cwd: "/Users/kite/Developer/aishell",
  control_id: "aishell-capability-expansion-20260721",
  actor_id: "bell-root-20260722-ace035-execution",
  expected_revision: 137,
  task: {
    task_id: "ace035-production-benchmark-harness",
    title: "executor callbackを凍結fixture・MCP catalog・observer・oracleへ実接続する",
    classification: "F",
    effect: "write",
    doc_ref: "docs/development-efficiency-plan.md",
    role: "implementer",
    lane: "behavior-change",
    depends_on: ["ace035-codex-attempt-executor", "ace035-oracle-acceptance-aggregator"],
    validation: ["node --test benchmarks/test-phase3-production-harness.mjs", "git diff --check"],
    non_goals: ["test中に外部modelを起動しない", "凍結fixture/oracleを変更しない", "callback欠損をfallbackしない"],
    known_traps: ["setup/mutation/warm stepをscenarioごとexactly once", "tools/list raw bytesとcatalog digestを保持", "observerとoracleのharness-only値をmodelへ渡さない"],
    read_scope: [{ kind: "directory", path: "benchmarks" }],
    write_scope: [
      { kind: "file", path: "benchmarks/phase3-production-harness.mjs" },
      { kind: "file", path: "benchmarks/test-phase3-production-harness.mjs" },
    ],
    required_capabilities: ["workspace.read", "workspace.write", "process.execute", "report.structured"],
    isolation: "none",
    context_policy: { share_objective: true, share_current_candidate: true, share_existing_findings: true, share_failed_approaches: true, share_test_results: true },
    approval: null,
    alternative_group: null,
  },
});

process.stdout.write(`${JSON.stringify({ revision: result.revision })}\n`);
