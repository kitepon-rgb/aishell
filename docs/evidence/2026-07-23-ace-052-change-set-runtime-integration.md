# ACE-052 ChangeSet runtime統合証拠

- Date: 2026-07-23
- Lattice plan: `aishell-capability-expansion`
- Task: `ACE-052`

## 不具合と修正

`ApplyChangeSetService`は通常commitとrecoveryの両方で、実測した成功deltaを
`WorkspaceStateRuntime.appendKnownMutation`へ渡していた。しかしproduction factoryが
専用の`WorkspaceStateRuntime`を新規生成していたため、公開`workspace_snapshot`、
`workspace_wait`、context系toolが共有する`DevelopmentRuntimeService.workspaceRuntime`へ
deltaが届かなかった。

production factoryへ`WorkspaceStateRuntime`の注入を必須化し、MCP serverは
`DevelopmentRuntimeService.workspaceRuntime`を渡すようにした。これにより
`NativeFileService`と同じ許可rootを所有する公開MCP runtime上で、change set成功後の
file identity、workspace cursor、delta journalが一本化される。factory内部で別runtimeへ
silent fallbackする経路はない。

## 受入検証

次のfocused suiteを一回実行した。

```text
swift test --filter 'ChangeSetSafetyNetTests/testSuccessfulApplyAppendsWorkspaceDeltaWithoutRescan|ChangeSetSafetyNetTests/testRecoveryAndFSEventsEchoAppendKnownMutationExactlyOnceWithoutRescan|MCPApplyChangeSetWireTests'
```

結果は7 tests、failure 0。

- 通常commitのcreate/write/delete/renameを、開始cursor以後のdeltaとして取得した。
- renameの`previousPath`を保持した。
- mutation前後のworkspace scan invocation countが同一で、追加scanが0回だった。
- recovery後も同じdeltaを一度だけ反映し、後着FSEvents echoを重複させなかった。
- 公開`apply_change_set`のclosed schema、typed error、成功projectionを維持した。

## 変更面

- `Sources/AIShellCore/ChangeSetService.swift`
- `Sources/AIShellMCP/MCPServer.swift`
- `Tests/AIShellCoreTests/ChangeSetSafetyNetTests.swift`

