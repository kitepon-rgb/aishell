# ACE-053 Phase 5受入証拠

- Date: 2026-07-23
- Lattice plan: `aishell-capability-expansion`
- Task: `ACE-053`

## 受入中に修正した公開面

当初の公開`apply_change_set`は次の理由でAI hostから一度も正常requestを構成できなかった。

1. model-visible inputが管理app内部の`client_id / client_epoch / request_sequence`を必須としていた。
2. `workspace_snapshot`はopaque `ws2:` cursorを返す一方、tool inputは外へ公開されない内部transaction cursor objectを要求していた。
3. production system clockではowner proofの有効期間がregistry基準で300秒を数ms超え、初回allocationが常に`CLIENT_OWNER_PROOF_INVALID`になった。

公開inputを`path + workspace_cursor + changes`へ修正した。MCP adapter自身がrootごとのdurable clientを所有し、active slotがなければ
最小free slotを一度だけ確保する。`workspace_cursor`以後のdeltaが空であることを共有runtimeで検証してから内部transaction cursorへ
変換し、成功resultへ`workspace_from_cursor`とknown mutation反映後の`workspace_cursor`を返す。client identityとsequenceは追跡用resultには
残すが、AIへ入力管理を要求しない。production clockはowner proof／registry operationと同じ`now`へ束縛した。

## host apply_patch比較

同じbefore treeとcreate/write/delete/renameの4変更を、SHA guard付きhost `apply_patch`相当loopとdurable candidateで比較した。

| 指標 | host apply_patch相当 | `apply_change_set` |
|---|---:|---:|
| model/tool境界の呼出し | 4 | 2 |
| 明示確認call | 必要 | 不要 |
| 再snapshot call | 必要 | 不要 |
| 追加filesystem scan | — | 0 |
| public tree digest | 同一 | 同一 |
| partial write | 0 | 0 |
| wall time（今回のdebug実測） | 4.00 ms | 1,639.52 ms |

candidateはdurable reservation、fsync、transaction journal、完全diff、runtime receiptを含むため、非durableなhost相当よりwall timeが大きい。
Phase 5ではcorrectnessと確認roundtrip削減を受入れ、wall改善は主張しない。provider報告tokenを採取していないためtoken削減率も主張しない。

## 公開wire検証

```text
swift test --filter 'MCPApplyChangeSetWireTests|ChangeSetSafetyNetTests/testPhase5TransactionLoopMatchesHostPatchAndRemovesConfirmationRoundTrips|ChangeSetSafetyNetTests/testSuccessfulApplyAppendsWorkspaceDeltaWithoutRescan|ChangeSetSafetyNetTests/testRecoveryAndFSEventsEchoAppendKnownMutationExactlyOnceWithoutRescan'
```

結果は9 tests、failure 0。

- `workspace_snapshot`のopaque cursorからclient plumbingなしで2-file transactionをcommitした。
- 更新後opaque cursor、完全diff artifact、内部追跡identityを欠落なく返した。
- 入力cursor以後のdeltaを同じcursorから再生でき、scan invocation countは前後同一だった。
- commit前のstale workspace cursorを`WORKSPACE_CHANGED`で拒否し、対象fileを作らなかった。
- normal commit、recovery、後着FSEvents echoでdeltaを一度だけ反映した。
- closed schema、typed error、destructive/idempotent annotationを維持した。

