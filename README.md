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
- 管理アプリから許可フォルダ選択、全停止、操作履歴確認
- MCP 2025-11-25 stdio接続

## 起動

### npmからインストール

対応環境はApple Silicon Mac、macOS 15以降。

```text
npm install -g aishell
open ~/Applications/AIShell.app
```

global installは `AIShell.app` を `~/Applications` へ配置し、`aishell-mcp` コマンドをPATHへ追加する。現在はDeveloper ID署名・notarization前の実験版である。

### ソースから起動

ローカル成果物は `build/AIShell.app`。Finderから通常のMacアプリとして起動できる。

最初に「フォルダを選択」でAIに操作させる範囲を選ぶ。停止中はMCPからのファイル操作とアプリ操作をどちらも拒否する。

MCP実行ファイルはアプリ内に同梱される。

```text
/Users/kite/Developer/aishell/build/AIShell.app/Contents/Helpers/aishell-mcp
```

## 別のCodexタスクから使う

個人用のグローバルMCPとして登録する。npm版ではPATH上の絶対パスを指定する。

```text
codex mcp add aishell -- /opt/homebrew/bin/aishell-mcp
```

このMacでは登録済み。新しく開始したCodexタスクから `aishell` の19ツールを利用できる。操作を許可するときは `AIShell.app` を開いて対象フォルダを確認し、「AI操作を再開」を押す。停止中も `runtime_status` は使えるが、ファイル、アプリ、process操作は拒否される。

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
