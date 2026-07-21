# WorkspaceCheckpointStore focused evidence

- Date: 2026-07-21
- Lattice task: `ACE-012a`
- Contract: `docs/adr/0006-persistent-workspace-checkpoint-contract.md`

## 実装

- `RuntimeStore.baseDirectory/workspaces/<root_digest>/checkpoint.json`へ決定的JSONを保存する専用actorを追加。
- root/schema、entry path/hash invariant、payload SHA-256をload時に再検証。
- temporary fileへの完全writeとfsync後だけatomic replaceし、失敗時は直前の有効checkpointを保持。
- per-root entry/byte、root数、全体byte quotaをpreflightし、inactive checkpointだけをLRU順に完全directory単位でevict。
- corrupt、unsupported、migration、quota、write failureを`AIShellError`とMCP stable error codeへ追加。
- 先行12 scenario fixtureをSwift test resourceとして同じ期待値で消費。

Workspace runtimeへのrestore統合とcheckpoint access/activity記録はACE-012、event ID journalはACE-012bが所有する。

## 検証

```text
$ swift test --filter WorkspaceCheckpointStoreTests
Executed 8 tests, with 0 failures (0 unexpected)

$ node benchmarks/validate-workspace-checkpoint-safety-net.mjs
{"schema":"aishell.workspace-checkpoint-safety-net-result.v1","cases":12,"required_cases":12,"silent_fallbacks":0,"status":"passed"}

$ git diff --check
(no output)
```

focused testはwarm round-trip、決定的entry順、corrupt/unsupported保存、per-root quota、atomic replace失敗、
inactive LRU eviction、active root非eviction、先行fixture完全性を確認した。
