# ACE-024 Phase 2 acceptance

- Lattice task: `ACE-024`
- Date: 2026-07-23
- Repaired predecessors: benchmark freeze `1bc8efa`、shared retained view `9776af6`、search v2 reacceptance `d61f08f`、context integration reacceptance `369bb2e`

## Gate中に検出・修正した不具合

最初のfull gateは501件中1件失敗した。`WorkspaceStateRuntimeTests.testWarmRestartContinuesCheckpointCursorAndRetainsOlderConsumerInterval`で、再起動後に古いconsumer cursorを再生すると`.modified`の意味変更が消失した。

原因は、retained `journalEvents`だけをcheckpointへ永続化し、reconcile済みの`knownChangesBySequence`をメモリにしか保持していなかったこと。再起動時にはcurrent entryが既に更新済みなので、過去区間の意味変更を現在treeから再構築できなかった。

修正:

- checkpointへevent sequenceと結合した`journal_changes`を追加した。旧checkpointはoptional fieldとして引き続きdecodeできる。
- restore時に意味変更を復元し、retained eventと同じ寿命で保存・剪定する。
- 保存配列をsequence昇順へ正規化し、辞書iteration順による非決定的checkpoint拒否をなくした。
- orphan sequence、再起動replay、複数変更を伴う通常delta経路をfocused testで固定した。

focused verification:

```text
swift test --filter 'WorkspaceStateRuntimeTests|WorkspaceCheckpointStoreTests|ObservationJournalTests'
Executed 55 tests, with 0 failures
```

## Phase 2 full gate

```text
swift test
Executed 502 tests, with 0 failures

scripts/package-app.sh release
Build complete
build/AIShell.app generated and signed
```

Phase 2 acceptance fixture:

```json
{"aishell_model_visible_calls":2,"diff_pages":1,"diff_recall":3,"native_model_visible_calls":5,"search_pages":22,"search_recall":27,"token_measurement":"not_measured"}
```

warm restart benchmark:

```json
{"cold_content_reads":120,"content_read_reduction_percent":100,"delta_oracle":"passed","files":120,"warm_content_reads":0}
```

## 判定

- diff recall、search recall、continuation integrityはfull gateで通過した。
- fixture上のmodel-visible callはnative 5回に対してAIShell 2回だった。
- warm restartは同一fixtureでcontent readを120回から0回へ削減し、delta oracleも通過した。
- `token_measurement`は`not_measured`であるため、provider報告tokenの削減率は主張しない。

以上により、Phase 2を受け入れる。
