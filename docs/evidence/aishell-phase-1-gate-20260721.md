# Phase 1 永続workspace state gate evidence

- Date: 2026-07-21
- Lattice phase: `phase-1`
- Tasks: `ACE-010`, `ACE-011`, `ACE-012a`, `ACE-012b`, `ACE-012`, `ACE-013`

## Product result

120 fileの同一fixtureでcold startとwarm restartを比較した。

| 指標 | cold | warm | 判定 |
|---|---:|---:|---|
| content reads | 120 | 0 | 100%削減 |
| wall（単発参考値） | 656.34 ms | 631.76 ms | warmが約3.75%短い。改善主張には不使用 |
| entry/cursor oracle | 120 files fixture | 同一entry集合、同一cursor | passed |

benchmarkはproductionと同じFSEvents経路を使用し、再起動を跨ぐoffline modify/rename/deleteもoracle一致した。
wallは隔離反復ではないため、今回の単発値でwarm側が短くても速度改善を製品効果として主張しない。Phase 1のhard gateは
content再読とcorrectnessであり、overall p50は後続の製品gateで判定する。

## Correctness and fail-closed

- checkpoint payload/root/schema/entry/journal invariantをload時に検証。
- corrupt/unsupported/quota/write failureはtyped errorで、旧checkpointを削除・置換しない。
- FSEventsはroot deviceのper-device streamを使い、volume UUIDとevent IDを同じ系列へ束縛する。
- callbackを同期bufferへ保持し、watermarkは開始境界と同期drainで実際に処理したevent IDだけへ進める。
- gap/drop/wrap/root changeはroot pathのeventも除外前に明示判定する。
- `last_event_id=null`はwarm restoreへ使わず、deltaでは`RESCAN_REQUIRED`、明示fullでは再構築する。
- 保存watermarkが現在のsystem event IDより未来ならevent database巻戻りとして`RESCAN_REQUIRED`にする。
- root deviceのFSEvents UUIDをcheckpointへ束縛し、不一致・取得不能ではwarm deltaを拒否して明示fullだけを再構築する。
- restore中のgap/dropは明示fullで旧entryを全廃し、再構築中にもgap/dropが続けばfresh扱いせず停止する。
- checkpoint entryをOS metadataとevent replayへ照合し、変更pathだけcontentを再読。
- 同一sizeかつmtimeを元へ戻した実FSEvents変更もcontent hash差分として検出。
- 最新checkpoint cursorは再起動直後から直接継続し、圧縮点より古いcursorは`CURSOR_EXPIRED`。
- 同path root identity置換は再起動を跨いでも`RESCAN_REQUIRED`。
- silent full scan、silent checkpoint fallback、silent truncationは0件。

## Verification

```text
$ swift test --filter WorkspaceWarmRestartBenchmarkTests
Executed 1 test, with 0 failures
{"cold_content_reads":120,"cold_wall":"0.656343042 seconds","content_read_reduction_percent":100,"delta_oracle":"passed","files":120,"schema":"aishell.workspace-warm-restart-benchmark.v1","warm_content_reads":0,"warm_wall":"0.631755542 seconds"}

$ swift test --filter 'Workspace(StateRuntime|CheckpointStore)Tests|WorkspaceWarmRestartBenchmarkTests|ObservationJournalTests'
Executed 46 tests, with 0 failures (0 unexpected)

$ swift test
Executed 81 tests, with 0 failures (0 unexpected)

$ node benchmarks/validate-workspace-checkpoint-safety-net.mjs
13 required cases, silent_fallbacks=0, status=passed

$ git diff --check
(no output)

$ scripts/package-app.sh release
Build complete; build/AIShell.app signed and packaged
```

## Maintenance wave

実装中に見つけた日時round-trip由来の偽delta、scan/reconcile二重content read、再起動直後delta拒否、
適用済みentryへのevent再適用によるdelta消失は、その場で修正しfocused回帰へ固定した。独立監査が指摘したnull watermark、
root pathのdrop flag除外、callback後の非同期処理とglobal watermarkの競合、実FSEventsを通らないbenchmarkも同じwaveで修正した。
併せてfull再構築境界で旧prefetchを破棄し、root deviceのFSEvents UUIDをcheckpointへ束縛した。evictionはrollback可能な
staging transactionへ変更し、rollback不能時は復旧用stagingを保持する。空directoryをquotaへ数えないようにし、activity、
`checkpointState`、quota診断を公開結果へ反映した。
Phase gate時点で既知の未処理maintenance候補は0件である。

## Independent refutation

独立反証は最終的にPhase 1 blocker 0、機能削減なしと判定した。検討中には保存event IDと
`FSEventsGetLastEventIdForDeviceBeforeTime`の即時比較を追加する案も出たが、同APIの値が実測で6秒以上遅延し、
同一fixtureのcontent readを120から480へ増やして5 assertionを壊す偽陽性だったため棄却した。Apple SDKの契約どおり、
同一volume UUIDへ束縛した最新のper-device stream IDを継続点とし、timestamp境界は初回checkpointの保守的な開始値にだけ使う。
裁定は `docs/adr/0007-phase-1-acceptance.md` に固定した。
