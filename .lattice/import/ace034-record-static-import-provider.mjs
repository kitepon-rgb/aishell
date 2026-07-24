import { taskRecord } from "/Users/kite/Developer/dotagents/lib/orchestrate/control-record.mjs";

const result = await taskRecord({
  cwd: "/Users/kite/Developer/aishell",
  control_id: "aishell-capability-expansion-20260721",
  actor_id: "bell-root-20260722-ace034-benchmark-adapter",
  expected_revision: 128,
  task: {
    task_id: "ace034-static-import-impact-provider",
    title: "production change_impactへ凍結fixtureと同一IDのstatic-import providerを追加する",
    classification: "F",
    effect: "write",
    doc_ref: "docs/adr/0012-change-impact-contract.md",
    role: "implementer",
    lane: "behavior-change",
    depends_on: ["ace034-public-runtime-wire-integration"],
    validation: [
      "swift test --filter StaticImportChangeImpactProviderTests",
      "swift test --filter ChangeImpactServiceTests",
      "git diff --check",
    ],
    non_goals: [
      "dynamic importを静的依存へ推測しない",
      "未対応ecosystemをcompleteとして扱わない",
      "既存filesystem providerを削除・縮小しない",
    ],
    known_traps: [
      "changed fileからのreverse transitive dependencyとrelated testを区別する",
      "解析した全fileをfreshness bindingへ含めfalse-freshを防ぐ",
      "解決不能なdynamic importをcoverage gapとして保持する",
      "root外・symlink・巨大binaryを依存先へ昇格しない",
    ],
    read_scope: [
      { kind: "file", path: "Sources/AIShellCore/ChangeImpactService.swift" },
      { kind: "file", path: "Tests/AIShellCoreTests/ChangeImpactServiceTests.swift" },
      { kind: "file", path: "docs/adr/0012-change-impact-contract.md" },
      { kind: "file", path: "benchmarks/capability-fixtures.v1.json" },
    ],
    write_scope: [
      { kind: "file", path: "Sources/AIShellCore/StaticImportChangeImpactProvider.swift" },
      { kind: "file", path: "Sources/AIShellCore/ChangeImpactService.swift" },
      { kind: "file", path: "Tests/AIShellCoreTests/StaticImportChangeImpactProviderTests.swift" },
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
