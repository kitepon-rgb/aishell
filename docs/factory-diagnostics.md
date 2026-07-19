# Factory diagnostics contract

AIShellは開発工場向けのread-only MCP tool `factory_diagnostics`を公開する。
レスポンスschemaは`aishell.native_factory_diagnostics.v1`で固定する。

## 公開する状態

- 製品identifierとversion
- 対応OS、architecture、minimum OS、support判定
- runtime configuration schema、migration状態、設定の妥当性、操作readiness
- 設定root、自動Git worktree、実効rootの**件数**
- MCP stdio transportとprotocol readiness
- 管理アプリbundleのreadiness
- typed issue code

`paused`と`not_configured`は製品故障ではなく操作readinessとして表す。
設定JSONのdecode失敗と無効rootは製品readinessをfalseにする。

## privacy

診断は次を公開しない。

- 許可root、Git worktree、実効rootのpath
- activity履歴、操作target、message
- ファイル本文
- process executable、argument、environment、stdout、stderr

path情報が必要な対話操作は既存の`runtime_status`を使い、factory reporterとBugHubは
`factory_diagnostics`だけを取り込む。

## versionとmigration

- diagnostics schema: `aishell.native_factory_diagnostics.v1`
- runtime schema: `aishell.runtime_configuration.v2`
- 旧単一`allowedRootPath`は既存どおりcompatible-on-readで複数`allowedRootPaths`へ解釈する
- schema変更時は新versionを追加し、既存consumerを無言で読み替えない
