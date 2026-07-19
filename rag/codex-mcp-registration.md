# AIShellをCodexの別タスクへ公開する

- 出典: [[raw/codex-global-mcp-config]]
- 取得・検証日: 2026-07-19
- 確度: 高（公式仕様 + ローカル実測）

## 判断

AIShellはネットワークサーバーや常駐daemonにせず、アプリに同梱したMCP helperをCodexの個人設定へstdio serverとして登録する。これにより、同じMac上の新しいCodexタスクから利用でき、OS操作の許可範囲と停止状態はAIShell側のランタイム設定へ集約される。

## 登録

```text
codex mcp add aishell -- /Users/kite/Developer/aishell/build/AIShell.app/Contents/Helpers/aishell-mcp
```

## 実測

- `codex mcp get aishell`: `enabled: true`、`transport: stdio`
- `codex mcp list`: `aishell` を有効なserverとして表示
- 同梱helper: `tools/list` で19ツール、`runtime_status` 応答済み
- 停止中: `process_run` をAIShell側で拒否

`codex --strict-config mcp get aishell` は、現行CLIが `codex mcp` で `--strict-config` をサポートしないため検証経路として使用できなかった。通常の `get/list` は設定を正常に解析した。
