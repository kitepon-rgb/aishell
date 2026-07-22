# ACE-063 worktree / branch比較mode 受入証拠

- 取得日: 2026-07-23
- 対象: `ace-063`
- 確度: Core、ContextCompiler、MCP wireの実Git fixtureで確認済み

## 実装

- `workspace_snapshot.git_diff.mode`へ`worktree | branch`を追加した。省略時は`base_ref`なしならworktree、ありならbranchを選ぶ。
- branch modeは`base_ref`必須で、欠損時は`INVALID_COMPARISON_MODE`として停止する。
- `GitDiffContextResult`はdiff本文のbyte budget外で`comparisonMode`、repository root identity、HEAD branch/SHA、base ref/SHA、`dirtyState: clean | dirty`を返す。
- detached HEADはbranchを推測せず`null`とする。base解決失敗、repository外、race、continuation改ざんは既存typed error契約を維持する。
- change/patchは既存の1〜1,048,576 byte budget、omitted bytes、opaque continuation、完全artifactを維持する。
- Gitは`/usr/bin/git`をexecutable URLと引数配列で直接起動し、shell文字列を評価しない。

## 検証

```text
GitContextProviderTests: 17 passed
ContextCompilerServiceTests: 11 passed
MCPContextV2WireTests: 4 passed
workspace branch comparison wire test: 1 passed
```

wire fixtureではbase commit後にHEAD commitと未stage変更を作り、`mode: branch`、`base_ref`、`byte_budget: 1024`をMCPへ送った。結果は非空repository identity、`headBranch: main`、指定base SHA、`dirtyState: dirty`を返し、`returnedBytes <= 1024`だった。
