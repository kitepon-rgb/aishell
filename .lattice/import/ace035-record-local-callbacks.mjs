import { taskRecord } from "/Users/kite/Developer/dotagents/lib/orchestrate/control-record.mjs";

const result = await taskRecord({
  cwd: "/Users/kite/Developer/aishell",
  control_id: "aishell-capability-expansion-20260721",
  actor_id: "bell-root-20260722-ace035-execution",
  expected_revision: 138,
  task: {
    task_id: "ace035-local-production-callbacks",
    title: "production harnessをlocal Codex・AIShell・observerへ具体接続する",
    classification: "F",
    effect: "write",
    doc_ref: "docs/development-efficiency-plan.md",
    role: "implementer",
    lane: "behavior-change",
    depends_on: ["ace035-production-benchmark-harness"],
    validation: ["node --test benchmarks/test-phase3-local-callbacks.mjs", "git diff --check"],
    non_goals: ["test中に外部modelを起動しない", "provider metadata欠損をrequested modelで補わない", "未知traceを推測しない"],
    known_traps: ["MCP stdio request/responseのexact bytesを保持", "setup warm stateをmeasured attemptと同じruntimeへ置く", "Codex JSONL/tool traceの未知formatは明示error"],
    read_scope: [{ kind: "directory", path: "benchmarks" }],
    write_scope: [
      { kind: "file", path: "benchmarks/phase3-local-callbacks.mjs" },
      { kind: "file", path: "benchmarks/test-phase3-local-callbacks.mjs" },
    ],
    required_capabilities: ["workspace.read", "workspace.write", "process.execute", "report.structured"],
    isolation: "none",
    context_policy: { share_objective: true, share_current_candidate: true, share_existing_findings: true, share_failed_approaches: true, share_test_results: true },
    approval: null,
    alternative_group: null,
  },
});

process.stdout.write(`${JSON.stringify({ revision: result.revision })}\n`);
