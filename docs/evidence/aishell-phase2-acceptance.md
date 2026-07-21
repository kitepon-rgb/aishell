# Phase 2 context統合 受入証拠

- 日付: 2026-07-22
- Lattice task: `ace-024`
- 初回検出base: `ff00cf9c2ec84d4d53a5f9bb33bc5cc5360cbbf9`
- 修正後隔離base: `5a763cb2624e813003cc22bdef208db9ba63e1a7`
- fixture: `Tests/AIShellCoreTests/Phase2AcceptanceTests.swift`
- fixture SHA-256: `4ac489b6d3ffb8beca2967c24a2ce9b4231ff6d9523a4bdf84a50cd178c08d55`
- 判定: **pass**。検出した2件のP1を修正したcandidateでPhase 2専用gate 3/3 green。

## 隔離条件

修正commit `5a763cb`のdetached worktreeへ専用testだけを配置した。baseに含まれる
`ChangeSetSafetyNetTests.swift`は別taskの意図的compile-redであるため、隔離worktree内だけでtest targetから退避した。
共有worktreeのChangeSet WIP、未追跡ADR、`.codegraph/`、production sourceは変更していない。

修正commitは`WorkspaceStateRuntime.swift`／同test、`GitContextProvider.swift`／同test、
`ContextCompilerServiceTests.swift`。所有workerの関連gateはWorkspace 29/29、ContextCompiler 10/10、
GitProvider 17/17、MCPContextV2Wire 3/3 greenだった。

## 独立green gate

```text
swift test --filter Phase2AcceptanceTests/testIntegratedContextPreservesRecallBudgetAndContinuationWithFewerModelVisibleCalls
```

結果は1 test / 0 failure。出力した決定的な計測値は次のとおり。

```json
{"aishell_model_visible_calls":2,"diff_pages":1,"diff_recall":3,"native_model_visible_calls":5,"schema":"aishell.phase2-acceptance.v1","search_pages":22,"search_recall":27,"token_measurement":"not_measured"}
```

このgateは次を確認した。

- staged rename、同一pathのunstaged変更、untracked追加のdiff recall 3件
- fixed複数queryを1 requestへ束ねたsearch recall 27件
- search continuationを全22 page連結するとunpaged結果と一致すること
- 各search pageの`returnedBytes <= 1_024`と`hasMore == (continuation != nil)`
- 同長token改ざんが`cursorExpired(reason: "integrity_mismatch")`になること
- 同じfixtureでnativeの5 model-visible process callに対しAIShellが2 model-visible callで同じdiff/search oracleを満たすこと

provider報告tokenを同一model snapshot・prompt・sandboxで採取していないため、token削減率は計測も主張もしない。
call数はmodel-visible tool境界だけを数え、AIShell内部worker数を混ぜていない。

## P1-A: snapshot後にchanged search cursorが自己失効した

```text
swift test --filter Phase2AcceptanceTests/testWorkspaceSnapshotKeepsChangedSearchCursorConsumableForDrilldown
```

修正前は1 test / 1 unexpected failure。

```text
WorkspaceStateRuntime.swift:325: cursorExpired("ws2:...")
```

`workspace_snapshot(since_cursor: C)`がobservation journalをreconcile後に破棄し、直後の
`search_context(changed_since_cursor: C, ranking: changed)`が同じ区間を再生できない。
これはMCP instructionsの「workspace_snapshotから開始し、snapshot不足時にsearch_contextでdrilldownする」正規導線を壊す。
silent full-scan fallbackではなく、consumer間で同一区間を再生できるretention/cursor所有へ直す必要がある。
修正commitはmemory上のretained journalとpersisted checkpointの圧縮点を分離し、同testは1/1 greenになった。

## P1-B: workspace Git diff continuationが変更なしでも自己失効した

```text
swift test --filter Phase2AcceptanceTests/testWorkspaceSnapshotGitDiffContinuationRoundTripsWithoutFilesystemChange
```

修正前は1 test / 1 unexpected failure。

```text
GitContextProvider.swift:384: contentChanged
```

最初の`workspace_snapshot(git_diff.byte_budget: 1)`が返したcontinuationを、filesystem変更なしで次の
`workspace_snapshot(git_diff.continuation: token)`へ渡しても、再生成された`GitWorkspaceComparisonBinding`がretained bindingと一致しない。
direct providerの固定binding testだけでは公開統合面の往復不能を検出できない。
修正commitは内容同一性から観測位置cursor/generationを分離し、同testは1/1 greenになった。

## 修正後の統合受入

2 regressionを個別にgreen確認した後、次を1回実行した。

```text
swift test --filter Phase2AcceptanceTests
```

`5a763cb`から作成したfresh detached worktreeで、2 regressionは各1 test / 0 failures、
全体は3 tests / 0 failures。diff/search recall、continuation全件復元、model-visible budget、
5対2 call比較を同じcandidateで同時に満たした。provider報告tokenを採取していないため、token削減率は引き続き主張しない。
