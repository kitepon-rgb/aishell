# AIShell 0.3.0

## 変更点

- read-only MCP tool `factory_diagnostics`を追加した。
- version付きschema `aishell.native_factory_diagnostics.v1`で、platform、MCP、runtime store、manager readiness、pause状態を返す。
- 診断では許可root path、ファイル本文、操作履歴、process引数を返さない。
- `process_run`が子プロセスのstdinを明示的に閉じ、`codex exec`などのstdin readerへEOFを届けるよう修正した。

## 対応環境

- macOS 15以降
- Apple Silicon (`arm64`)

## 受入

- Swift test 20/20
- release package整合性検証
- 実MCP 21 tool handshake
- Codex実セッションからcandidate `factory_diagnostics`を1回呼び出し、schema v1、ready、issues 0、privacy非露出を確認
- candidate `process_run`で`/bin/cat`がtimeoutせずexit 0になることを確認

## rollback

`@quolu/aishell@0.2.1`をglobal installし直し、AIShell appとMCP clientを再起動する。runtime store schemaはv2のまま互換で、データ削除は不要。
