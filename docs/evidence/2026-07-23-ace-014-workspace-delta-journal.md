# ACE-014 WorkspaceDeltaJournal retained view evidence

- Lattice task: `ACE-014`
- Date: 2026-07-23
- Scope: effective-root owner解決と、context／snapshot／将来のwaitが共有するroot-scoped retained view

## 実装

- `EffectiveRootProjectCatalog`がallowed root集合をUTF-8 byte orderで正規化し、requestを包含する最深rootを一意に選ぶ。
  policy digestは設定順に依存せず、owner identityは実directoryのdevice/inodeへ束縛する。
- 既存path observation logのdomain ownerを`WorkspaceDeltaJournal`として明示し、旧内部名はv1 checkpoint/test互換aliasだけにした。
- `workspaceDeltaObservation`をsearch固有メタデータから分離した。返却viewはroot identity、policy digest、from/through cursor、
  immutable view ID、retention floor、head sequence、changed paths、indexed file identity/SHAを保持する。
- delta snapshotの完了をconsumer acknowledgementとして扱わず、retained event全体をchecksum付きworkspace checkpointへ保存する。
  search／snapshotのreadでin-memory head又は他consumerの可視区間を進めない。
- viewでfilesystem照合したentryとjournalを同じcheckpointへcommitするため、再起動後も同じfrom cursorから同じviewを再生する。
- `searchContextObservation`は共通viewへ委譲し、test分類とproject profile digestだけを検索用projectionとして足す。

ACE-044が所有するv2 immutable segment manifest、writer lease、waiter registry、generation cutoverはこのtaskでは実装していない。
このtaskはそれらが読む共通domain viewとrestart retention seamを固定し、検索専用journal／wait専用journalの新設を不要にする。

## focused verification

```text
swift test --filter 'WorkspaceStateRuntimeTests|ObservationJournalTests|ContextCompilerServiceTests/testV2SearchUsesRetainedObservationAndDedicatedService'

Executed 46 tests, with 0 failures
```

追加gateは、同じ変更区間を最初のsearch、delta snapshot後のsearch、runtime再起動後のconsumerが読み、
`WorkspaceDeltaObservation`全体が一致することを検証する。既存retention上限テストは、floor以前のcursorが
`CURSOR_EXPIRED`のままでsilent full scanへfallbackしないことを引き続き検証する。

`git diff --check`はexit 0。
