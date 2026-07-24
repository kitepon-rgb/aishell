import { taskRecord } from "/Users/kite/Developer/dotagents/lib/orchestrate/control-record.mjs";

const result = await taskRecord({
  cwd: "/Users/kite/Developer/aishell",
  control_id: "aishell-capability-expansion-20260721",
  actor_id: "bell-root-20260722-ace034-benchmark-adapter",
  expected_revision: 129,
  task: {
    task_id: "ace034-depfile-impact-provider",
    title: "production change_impactへ凍結fixtureと同一IDのdepfile providerを追加する",
    classification: "F",
    effect: "write",
    doc_ref: "docs/adr/0012-change-impact-contract.md",
    role: "implementer",
    lane: "behavior-change",
    depends_on: ["ace034-public-runtime-wire-integration"],
    validation: [
      "swift test --filter DepfileChangeImpactProviderTests",
      "swift test --filter ChangeImpactServiceTests",
      "git diff --check",
    ],
    non_goals: [
      "欠損depfileを影響なしへ丸めない",
      "compiler固有の不明構文を推測しない",
      "既存providerを削除・縮小しない",
    ],
    known_traps: [
      "Make depfileの継続行とescaped spaceを決定的に扱う",
      "depfile自身をfreshness bindingへ含める",
      "欠損・不正depfileをcoverage gapとして保持する",
    ],
    read_scope: [
      { kind: "file", path: "Sources/AIShellCore/ChangeImpactService.swift" },
      { kind: "file", path: "docs/adr/0012-change-impact-contract.md" },
      { kind: "file", path: "benchmarks/capability-fixtures.v1.json" },
    ],
    write_scope: [
      { kind: "file", path: "Sources/AIShellCore/DepfileChangeImpactProvider.swift" },
      { kind: "file", path: "Sources/AIShellCore/ChangeImpactService.swift" },
      { kind: "file", path: "Tests/AIShellCoreTests/DepfileChangeImpactProviderTests.swift" },
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
