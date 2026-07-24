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
- npm同梱helper: default `tools/list`で高密度5 toolと復旧control 2 tool、`AISHELL_TOOL_PROFILE=full`で25 tool
- 0.3.4の`AISHELL_CAPABILITY_SET=expanded-v1`: 高密度9 tool＋復旧control 2 tool、expanded fullは29 tool。未知・空のcapability/profile値はtyped startup errorで停止しsilent fallbackしない
- default/full両profileで`runtime_status`と停止中の`runtime_open_manager`を公開する。0.3.2以前のdefault 5面で回復toolを案内しながら非公開だった契約欠陥は0.3.3で修正
- 停止中: `process_run` をAIShell側で拒否
- 0.2.1: 設定rootに属するGit worktreeを `automaticGitWorktreePaths` と `effectiveAllowedRootPaths` へ自動反映し、worktree単位の追加依頼を不要化
- 0.3.1: npm global install後のhelperでinitialize version `0.3.1`、default 5/full 25 toolを再検証。shell/env basename拒否は安全境界ではなく、高密度な直接process経路へ誘導する製品レールとして明文化
- 0.3.3: default 5 development toolへ`runtime_status`と`runtime_open_manager`を復旧controlとして追加し、未設定・停止・許可root外の案内先を同じ公開catalog内でcallableにした。fullは25 toolのまま
- 0.3.4: managed run、workspace wait、impact解析、atomic change setと既存toolのv2 schemaを`expanded-v1`のopt-in面として公開。development 11/full 29、MCP `2025-11-25`のcandidate toolはtop-level object `outputSchema`を持つ
- 0.3.5: `apply_change_set`が変更ごとに`after_content`（UTF-8テキスト4KiB以下）を返し、冗長な`result: "applied"`を削除。tool数・schema・catalog digestは0.3.4と不変（`a7fb8c…`）。global install後の実測で`initialize` version `0.3.5`、`expanded-v1` 11 tool、input/output schema欠落0、実`apply_change_set`が`after_content: "A2\n"`を返し`result`は非存在

`codex --strict-config mcp get aishell` は、現行CLIが `codex mcp` で `--strict-config` をサポートしないため検証経路として使用できなかった。通常の `get/list` は設定を正常に解析した。
