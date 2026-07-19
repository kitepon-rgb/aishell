# AIShell

AIがshell、Terminal、AppleScript、JXAを介さず、SwiftのmacOS APIを通してOSを直接操作する実験プロジェクト。

## 現在できること

- 許可フォルダ内の一覧、検索、UTF-8テキスト読取
- フォルダ／テキスト作成、copy、move、rename、Trash
- stat、SHA-256、再帰tree
- SHA-256競合検出付き原子的更新、旧テキストを事前条件にした部分置換
- executable URLと引数配列による開発プログラムの直接実行
- working directory、環境変数、timeout、stdout、stderr、終了コードの取得
- 実行中／インストール済みアプリの一覧
- bundle identifierによるアプリ起動・前面化
- 管理アプリから複数の許可rootを追加・削除、全停止、操作履歴確認
- 停止中でも状態確認と管理アプリ起動が可能
- 許可済みGitリポジトリに登録されたworktreeを追加操作なしで自動認識
- MCP 2025-11-25 stdio接続
- pathや操作本文を含めないversion付き`factory_diagnostics`

## 起動

### npmからインストール

対応環境はApple Silicon Mac、macOS 15以降。

```text
npm install -g @quolu/aishell
aishell-open
```

global installは `aishell-mcp` と `aishell-open` をPATHへ追加する。`aishell-open` はnpm package内の管理アプリをLaunchServicesで開く。install scriptは実行しない。現在はDeveloper ID署名・notarization前の実験版である。

### ソースから起動

ローカル成果物は `build/AIShell.app`。Finderから通常のMacアプリとして起動できる。

最初に「許可rootを追加」でAIに操作させる範囲を選ぶ。絶対パスはいずれかのrootへ自動的に対応し、相対パスは一覧の先頭rootを基準にする。許可済みGitリポジトリの `.git/worktrees` に正式登録され、双方の管理情報が一致するworktreeは自動的に実効rootへ加わる。worktreeごとの手動追加は不要。停止中は通常のファイル・アプリ・process操作を拒否するが、`runtime_status` と `runtime_open_manager` は利用できる。

MCP実行ファイルはアプリ内に同梱される。

```text
/Users/kite/Developer/aishell/build/AIShell.app/Contents/Helpers/aishell-mcp
```

## 別のCodexタスクから使う

個人用のグローバルMCPとして登録する。npm版ではPATH上の絶対パスを指定する。

```text
codex mcp add aishell -- /opt/homebrew/bin/aishell-mcp
```

このMacでは登録済み。新しく開始したCodexタスクから `aishell` の21ツールを利用できる。AIには次のように伝えればよい。

```text
AIShellを使いこなして。最初にruntime_statusを確認して。Git worktreeはautomaticGitWorktreePathsとeffectiveAllowedRootPathsへ自動反映されるので、worktreeごとの許可追加を私へ要求しないで。停止中または通常フォルダの許可root不足ならruntime_open_managerで管理画面を開いて。絶対パスはeffectiveAllowedRootPaths、相対パスはprimaryAllowedRootPathを基準に扱って。
```

`runtime_status` は設定root、自動認識したGit worktree、実効root、相対パスの基準、停止状態、次の操作を返す。停止中でも `runtime_open_manager` で管理アプリを前面化できるため、Computer Useや旧shellで入口を作る必要はない。許可root変更と再開は管理画面で人が行い、停止中の通常操作は引き続き拒否される。

開発工場の監視は[`factory_diagnostics`](docs/factory-diagnostics.md)を使う。このtoolは停止中でも利用でき、許可rootや操作履歴の実値を返さない。

登録確認と解除は次のとおり。

```text
codex mcp get aishell
codex mcp remove aishell
```

## 開発検証

```text
swift test
scripts/package-app.sh release
```

`xcodegen generate` で `AIShell.xcodeproj` を再生成できる。現在の検証機ではXcode 26.6とCoreSimulatorのbuild versionが一致せず、`xcodebuild` はXCBuild開始待ちで停止するため、同じSwift 6.3.3 toolchainを使うSwiftPMでビルド・テストした。この環境問題はソースの成功扱いへ混ぜていない。

## 実装上の禁止事項

`AIShellCore` と `AIShellMCP` は、shell、AppleScript、JXA、コマンド文字列を実行しない。開発プログラムは実行ファイルの絶対パスと引数配列を分離したままmacOSのprocess APIへ渡し、shell本体の起動、パイプ、リダイレクト、shell展開を拒否する。MCPは型付き要求をmacOSネイティブAPIへ渡すアダプターである。
