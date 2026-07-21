# 永続workspace runtime統合 evidence

- Date: 2026-07-21
- Lattice task: `ACE-012`
- Contracts: `docs/adr/0004-workspace-cursor-v2-contract.md`, `docs/adr/0006-persistent-workspace-checkpoint-contract.md`

## 実装

- `WorkspaceStateRuntime`へ`WorkspaceCheckpointStore`と`ObservationJournal`を統合。
- checkpoint entryを比較基準にし、metadata差分とFSEvents replay対象だけをcontent再読・reconcile。
- scan済みentryをprefetchとしてreconcileへ渡し、変更fileの二重content readを除去。
- FSEvents flush後のcurrent event ID、generation、journal sequence、未適用eventをcheckpointへ原子的に保存。
- 再起動直後のdelta requestを直接warm restoreし、checkpoint圧縮点より古いcursorは`CURSOR_EXPIRED`。
- 同pathのroot identity置換は再起動を跨いでも`RESCAN_REQUIRED`、corrupt checkpointは保存したまま
  `CHECKPOINT_CORRUPT`。silent full scanへfallbackしない。
- 日時の永続化往復誤差は1 microsecond未満だけ同一metadataとし、無変更fileの偽deltaと不要再読を防止。

既存full/delta、rename/delete、entry paging、symlink/exclusion、gap/retention契約は維持した。

## 検証

```text
$ swift test --filter 'Workspace(StateRuntime|CheckpointStore)Tests|ObservationJournalTests'
Executed 34 tests, with 0 failures (0 unexpected)

$ node benchmarks/validate-workspace-checkpoint-safety-net.mjs
{"schema":"aishell.workspace-checkpoint-safety-net-result.v1","cases":12,"required_cases":12,"silent_fallbacks":0,"status":"passed"}

$ git diff --check
(no output)
```

warm restart focused testでは無変更content再読0、offline metadata変更のcontent再読1、変更delta保持、最新cursorの
直接継続、圧縮点より古いcursor失効、再起動跨ぎroot置換、corrupt checkpoint保持を確認した。
