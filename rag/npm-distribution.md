# AIShell npm配布判断

- 出典: [[raw/npm-publishing-2026]]
- 検証日: 2026-07-19
- 確度: 高（公式仕様 + registry実測）

## 採用構成

- 公開名: `@quolu/aishell`
- 対応: macOS arm64、macOS 15以降
- `aishell-mcp`: npm `bin` からSwift製Mach-Oへ直接リンク
- `aishell-open`: package内の `AIShell.app` をLaunchServicesで開く明示コマンド
- lifecycle install script: 不採用

install scriptを使わないことで、npm 12の既定動作でもMCPと管理アプリ起動経路が欠けない。インストール時にユーザー領域へアプリを自動コピーする副作用もなくす。

## 実測

- 現行公開版: `@quolu/aishell@0.3.0`、dist-tag `latest`
- 次patch: `0.3.1`。shell/env basename拒否が製品上の設計レールでありsecurity boundaryではないことを配布文書へ同期する
- global install先: `/opt/homebrew/lib/node_modules/@quolu/aishell`
- PATH: `/opt/homebrew/bin/aishell-mcp`、`/opt/homebrew/bin/aishell-open`
- npm導入後のhelperはdefault profileで高密度5 tool、`AISHELL_TOOL_PROFILE=full`で25 toolを公開
- npm導入後のapp bundleでad-hoc署名検証成功
