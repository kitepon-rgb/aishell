# ACE-031／ACE-044b 並行実装wave受入証拠

- Date: 2026-07-22
- Control: `aishell-capability-expansion-20260721`
- Runtime: `.lattice/runs/aishell-ace031-ace044b-wave-20260722`
- Base commit: `df0b79f8c152aa860532315d339443aade7b582a`

## ACE-031 freshness cache safety net

- 専用worktree: `/Users/kite/Developer/aishell-worktrees/ace031-cache-safety`
- 変更: `Tests/AIShellCoreTests/RunCheckFreshnessCacheSafetyNetTests.swift`
- 親再検証: `swift test --filter RunCheckFreshnessCacheSafetyNetTests`
- 結果: 11 tests、0 failures。
- 受入範囲: binding変化、`off | prefer | only | refresh`、corruption、terminal eligibility、TTL境界、quota eviction、immutable generation conflictの安全網。
- 非主張: production cache/runtime統合はACE-034a以降で行う。

## ACE-044b artifact query service seam

- 専用worktree: `/Users/kite/Developer/aishell-worktrees/ace044b-artifact-query`
- 変更: `Sources/AIShellCore/ArtifactQueryService.swift`、`Tests/AIShellCoreTests/ArtifactQueryServiceTests.swift`
- 親再検証: `swift test --filter ArtifactQueryServiceTests`
- 結果: 9 tests、0 failures。
- 親監査で初回成果の全match/offset、canonical digest、source順、history identity、cursor errorを差し戻し、再監査でoversize rangeとregex flag closed setを追加修正した。
- 受入範囲: fixture入力query compiler、immutable result stream、pagination、binary rejection、history comparisonのownership seam。
- 非主張: EvidenceStore、project/store binding、production run index、MCP統合はACE-044で行う。

両worktreeで`git diff --check`は成功した。両工程はLattice compileでwrite conflict 0、capacity 2の同一waveとしてdispatchし、担当pathは重複していない。
