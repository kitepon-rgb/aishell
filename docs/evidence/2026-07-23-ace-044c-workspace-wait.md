# ACE-044c workspace_wait Core seam

- Lattice task: `ACE-044c`
- Date: 2026-07-23
- Predecessor: shared `WorkspaceDeltaJournal` `9776af6`、semantic replay correction `94da16c`

## 実装

- `WorkspaceStateRuntime.workspaceWait`を追加し、同じretained observation viewを非破壊にpollする。
- cursor以後のjournal headが既に進んでいれば、再起動後もdurable checkpointから即時replayする。
- retention gap、generation mismatch、FSEvents gapは既存typed errorをそのまま返し、full scanへfallbackしない。
- 期限到達時は`aishell.workspace-wait.v1`の`timed_out` resultを返す。
- Task cancellationは握り潰さず`CancellationError`として呼出側へ伝播する。
- wait pollはFSEvents delivery用の500ms graceを重ねず、無変更pollではcheckpointを書かない。retained eventをreconcileした時だけ意味変更を永続化する。

本taskは親工程`ACE-044`が公開MCP toolへ統合するためのCore seamである。Tool CatalogとMCP wireは本taskでは変更していない。

## focused verification

```text
swift test --filter 'WorkspaceWaitServiceTests|WorkspaceStateRuntimeTests|WorkspaceCheckpointStoreTests|ObservationJournalTests'
Executed 59 tests, with 0 failures

swift test --filter WorkspaceWaitServiceTests
Executed 4 tests, with 0 failures
```

確認した境界:

- durable cursor replayは再起動後もchanged pathを失わず、journal headを後退させない。
- retention外cursorは`CURSOR_EXPIRED`相当のtyped errorとなり、scan countは増えない。
- 無変更timeoutはcursorを進めず、空のchanged pathsを返す。
- cancellation後もjournalは消費・前進しない。
