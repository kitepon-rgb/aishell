# AIShellをCodexの別タスクへ公開する

- 出典: [[raw/codex-global-mcp-config]]
- 取得・検証日: 2026-07-19
- 確度: 高（公式仕様 + ローカル実測）

## 判断

AIShellはネットワークサーバーや常駐daemonにせず、アプリに同梱したMCP helperをCodexの個人設定へstdio serverとして登録する。これにより、同じMac上の新しいCodexタスクから利用でき、OS操作の許可範囲と停止状態はAIShell側のランタイム設定へ集約される。

## 登録

```text
codex mcp add aishell -- /opt/homebrew/bin/aishell-mcp
```

## 実測

- `codex mcp get aishell`: `enabled: true`、`transport: stdio`
- `codex mcp list`: `aishell` を有効なserverとして表示
- npm同梱helper: default `tools/list`で高密度5 tool、`AISHELL_TOOL_PROFILE=full`で25 tool
- full profileの`runtime_status`と停止中の`runtime_open_manager`は応答済み
- 停止中: `process_run` をAIShell側で拒否
- 0.2.1: 設定rootに属するGit worktreeを `automaticGitWorktreePaths` と `effectiveAllowedRootPaths` へ自動反映し、worktree単位の追加依頼を不要化
- 0.3.1: npm global install後のhelperでinitialize version `0.3.1`、default 5/full 25 toolを再検証。shell/env basename拒否は安全境界ではなく、高密度な直接process経路へ誘導する製品レールとして明文化

`codex --strict-config mcp get aishell` は、現行CLIが `codex mcp` で `--strict-config` をサポートしないため検証経路として使用できなかった。通常の `get/list` は設定を正常に解析した。
