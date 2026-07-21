# ObservationJournal focused evidence

- Date: 2026-07-21
- Lattice task: `ACE-012b`
- Contracts: `docs/adr/0004-workspace-cursor-v2-contract.md`, `docs/adr/0006-persistent-workspace-checkpoint-contract.md`

## 実装

- generation、monotonic sequence、path、FSEvents event ID、rescan reasonを保持する専用journalを追加。
- unsafe FSEvents flagをpath exclusionより先に判定し、drop/wrap/root changeを`RESCAN_REQUIRED`へ固定。
- event ID regressionをgapとして拒否し、event watermarkは除外pathでも更新。
- retention外sequenceと未来sequenceを`CURSOR_EXPIRED`にし、部分履歴やfull scanへfallbackしない。
- schema付きjournal checkpointの復元invariantと明示new-generation resetを追加。
- `FSEventsObserver`へ保存済みevent ID以後から開始する引数を追加。未指定時の現行since-now挙動は維持。

WorkspaceStateRuntimeへのjournal置換とcheckpoint同時確定はACE-012で行う。

## 検証

```text
$ swift test --filter ObservationJournalTests
Executed 6 tests, with 0 failures (0 unexpected)
```

focused testはcheckpoint round-trip、retention失効、除外path上のunsafe flag、event ID regression、
除外pathのsequence非進行とwatermark更新、corrupt checkpoint、新generation resetを確認した。
