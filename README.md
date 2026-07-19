# AIShell

AIの要求をshell文字列として解釈せず、SwiftのmacOS APIと指定された開発workerを通してOS状態を直接扱う実験プロジェクト。

## 現在できること

- 既定のdevelopment profileから、OS状態を束ねた5本の高密度toolを提供
  - `workspace_snapshot`: 初回scanのbounded previewとFSEvents由来の変更delta、Git状態、主要context
  - `read_context`: 複数fileのbudget付きread、SHA-256、continuation
  - `search_context`: `rg` workerによるbudget付き検索context
  - `run_check`: 直接process実行、主要診断、完全stdout/stderr artifact
  - `artifact_read`: artifactのrange、tail、pattern周辺read
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

新しく開始したCodexタスクでは、既定で上記5本のdevelopment toolを利用できる。従来のprimitiveを含む25 toolが必要な互換利用では、server環境へ`AISHELL_TOOL_PROFILE=full`を設定する。

```text
複数file・反復workspace観測ではworkspace_snapshotを使い、返されたcursorでdeltaを取って。32 KiBを超え得るbuild/test出力はrun_checkを使い、通常responseにない証拠だけartifact_readで読む。小さな単一file作業はCodex標準toolを使ってよい。
```

full profileの`runtime_status`は設定root、自動認識したGit worktree、実効root、相対パスの基準、停止状態、次の操作を返す。停止中でも`runtime_open_manager`で管理アプリを前面化できる。許可root変更と再開は管理画面で人が行い、停止中の通常操作は引き続き拒否される。

`run_check`は指定workerがfile更新・子process・network accessを行い得るため、MCPへdestructive/open-world capabilityとして掲示する。host設定によっては実行承認が必要になる。0.3のstdio serverは1 requestずつ処理し、timeout時のprocess tree終了は行うが、MCP cancellationと並列pollingは未実装である。

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

`AIShellCore` と `AIShellMCP` はshellやAppleScript/JXAの文字列を解釈せず、開発プログラム名を`PATH`から実行ファイルURLへ解決し、引数配列と分離したままmacOSのprocess APIへ渡す。shell本体、`env`、`osascript`の直接起動と、パイプ、リダイレクト、shell展開は拒否する。ただし許可された任意の開発workerが内部で何を起動するかまではAIShell 0.3の境界外である。MCPは型付き要求をOS-owned runtimeへ渡すアダプターである。
