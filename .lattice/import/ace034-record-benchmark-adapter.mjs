import { taskRecord } from "/Users/kite/Developer/dotagents/lib/orchestrate/control-record.mjs";

const result = await taskRecord({
  cwd: "/Users/kite/Developer/aishell",
  control_id: "aishell-capability-expansion-20260721",
  actor_id: "bell-root-20260722-ace034-benchmark-adapter",
  expected_revision: 127,
  task: {
    task_id: "ace034-benchmark-v1-production-v2-adapter",
    title: "凍結benchmark v1 requestをproduction v2へexact変換しprojection traceを保持する",
    classification: "F",
    effect: "write",
    doc_ref: "docs/adr/0012-change-impact-contract.md",
    role: "implementer",
    lane: "behavior-change",
    depends_on: ["ace034-public-runtime-wire-integration"],
    validation: [
      "node --test benchmarks/test-production-v2-benchmark-adapter.mjs",
      "node benchmarks/test-capability-request-materializer.mjs",
      "git diff --check",
    ],
    non_goals: [
      "凍結済みrepresentative suite・fixture・execution contractを書き換えない",
      "製品runtimeにlegacy benchmark requestの暗黙受理を追加しない",
      "ACE-035のprovider token計測runnerを先取りしない",
    ],
    known_traps: [
      "oracle・expected値・agent reportを変換やprojectionへ参照しない",
      "changed_pathsのSHAやworkspace cursorを推測・再scanで補完しない",
      "raw v2 resultをprojectionから再構成しない",
      "page・artifact不一致や未知itemをBENCHMARK_PROJECTION_INVALIDとして閉じる",
    ],
    read_scope: [
      { kind: "directory", path: "benchmarks" },
      { kind: "file", path: "docs/adr/0012-change-impact-contract.md" },
      { kind: "file", path: "Sources/AIShellMCP/MCPRunCheckAdapter.swift" },
      { kind: "file", path: "Sources/AIShellCore/ChangeImpactService.swift" },
    ],
    write_scope: [
      { kind: "file", path: "benchmarks/production-v2-benchmark-adapter.mjs" },
      { kind: "file", path: "benchmarks/test-production-v2-benchmark-adapter.mjs" },
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
