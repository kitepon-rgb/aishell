# AIShell npm配布判断

- 出典: [[raw/npm-publishing-2026]]
- 検証日: 2026-07-19
- 確度: 高（公式仕様 + registry実測）

## 採用構成

- 公開名: `@quolu/aishell`
- 対応: macOS arm64、macOS 15以降
- `aishell-mcp`: npm `bin` からSwift製Mach-Oへ直接リンク
- `aishell-open`: package内の `AIShell.app` をLaunchServicesで開く明示コマンド
- lifecycle install script: 助言専用の `postinstall` 1本だけ採用（0.4.4、2026-07-25に方針変更）

MCPと管理アプリの起動経路はどちらもinstall scriptに依存させない。npm 12は依存packageのlifecycle
scriptを既定で実行せず、利用者が `--ignore-scripts` を付ける場合もあるため、**scriptが走らなくても
機能が欠けない構成**を保つ。インストール時にユーザー領域へアプリを自動コピーする副作用も作らない。

0.4.4で例外を1つだけ設けた。`postinstall` が `scripts/check-running-instances.mjs` を実行し、
今回のinstallで置き換えられる実体を掴んだままの窓があればpidを挙げて再起動を促す（[[macos-app-upgrade-window-staleness]]）。
process一覧を読んで警告するだけで、書き込みも状態変更もせず、installを失敗させない。**scriptが走らない
環境ではこの警告が単に出ないだけ**で、検知の正はapp側（`InstallationIntegrity`）に置いてある。この
非対称が成立するのは、警告が復旧手段の前倒し通知でしかないからである。install scriptへ機能を載せない
という元の判断はそのまま生きている。

## 実測

- 公開・global install検証済み: `@quolu/aishell@0.3.1`、dist-tag `latest`
- registry shasum: `b6407da41c579a4a9e995bf8dc4654df43c05a07`
- global install先: `/opt/homebrew/lib/node_modules/@quolu/aishell`
- PATH: `/opt/homebrew/bin/aishell-mcp`、`/opt/homebrew/bin/aishell-open`
- npm導入後のhelperはdefault profileで高密度5 tool、`AISHELL_TOOL_PROFILE=full`で25 toolを公開
- npm導入後のMCP initializeはversion `0.3.1`を返却
- npm導入後のapp bundleでstrict deep code-signature検証成功
