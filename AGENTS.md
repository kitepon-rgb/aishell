# AIShell project instructions

## 製品目的

AIShellのnorth starは、**macOSの生きた状態を直接所有し、その状態からAI開発に必要な最小情報と操作を生成して、成功課題あたりの総model tokenと所要時間を減らすこと**。

優先順位:

1. correctness / task success
2. total model tokens per solved task
3. wall time / model・tool往復
4. compatibility

Direct OSは交換可能なbackendではなく、効率化を生む設計上の根である。AIShellがfile identity、OS変更の観測・照合state、process lifecycle、worktree、artifactをモデルより下で所有する。安全性は現行の許可root、停止、Trash、SHA競合検出を床として維持するが、現在の最適化対象ではない。

新機能は、OS状態を直接観測・保持して再scan、再読、再実行、model往復を減らせる場合だけ採用する。OS状態と無関係な便利toolや薄いwrapperを詰め込まない。

## 必要時の参照先

- roadmap、MCP surface、benchmark、context圧縮を変える時だけ`docs/development-efficiency-plan.md`を読む。
- 外部調査の前だけ`rag/INDEX.md`を検索する。
- 公開挙動、配布、利用手順を変える時だけ`README.md`を読む。
- legacy挙動の由来が必要な時だけ`docs/direct-os-spike.md`を読む。今後のGUIロードマップには使わない。

実装Phaseではplanのcheckboxとgateを更新する。削減率は、隔離された同一model snapshot、reasoning、fixture、prompt、sandboxでbaselineと比較できる場合だけ主張する。主KPIは失敗試行のtokenも含む`tokens per solved task`。wire bytesやtokenizer概算をprovider報告tokenと混ぜない。

## アーキテクチャ境界

- AI hostがreasoning、thread、compaction、sub-agent、汎用PTYを所有する。AIShellで再実装しない。
- AIShellは許可root、file identity、FSEvents観測とfilesystem照合によるdelta、直接起動したprocess、完全log/artifact、freshnessを所有する。FSEvents単独を完全な履歴とは見なさない。
- Git、`rg`、compiler、test runner、SourceKit-LSPはAIShellが直接起動・監視するworkerとして再利用する。状態の所有者や公開toolの寄せ集めにはしない。
- shell文字列を評価せず、executable URL、引数、working directoryを分離したままprocessを起動する。
- `AIShellCore`へdomain機能、`AIShellMCP`へprotocol変換を置く。MCP handlerへ開発ロジックを埋め込まない。
- 既存20 primitiveは互換経路・下位実装としてfull profileに残す。既定development profileの5 toolと合わせ、full profileは25 toolである。

## Tool / result規約

- stable MCP 2025-11-25を実装基準にし、structured resultはtop-level objectと`outputSchema`を持たせる。
- schema、tool順、descriptionは決定的にする。timestamp、cwd、runtime状態をdefinitionへ混ぜない。
- 通常結果は短いsummaryとprimary evidenceだけ。完全結果は`expires_at`付きhandleで保持する。
- 省略可能なread/search/run系高密度出力にbudgetを設け、`omitted`、`has_more`、cursor、freshnessを明示する。
- silent truncation、silent full-scan fallback、silent backend fallbackは禁止する。advertised retention中の一次証拠を削除しない。
- cursor失効、内容変更、index staleは機械判定可能なerrorにする。
- 新しい公開toolは、既存toolとの重複とbaseline比較を示してから追加する。

## 開発と検証

主な構成:

- `Sources/AIShellCore`: file/process/runtime/domain service
- `Sources/AIShellMCP`: stdio JSON-RPC / MCP adapter
- `Sources/AIShellApp`: macOS管理アプリ
- `Tests/AIShellCoreTests`: focused unit/integration tests
- `docs/`: active planと設計判断
- `rag/`: 調査統合、`rag/raw/`: 一次資料変換物

標準確認:

```text
swift test
scripts/package-app.sh release
```

変更中は対象focused testだけを回し、完了時に関連testを1回確認する。MCP wire変更ではinitialize、tools/list、成功・失敗resultのfixtureを確認する。docs/RAG/AGENTSだけの変更ではSwift testを回さず、リンク、Markdown、diffを確認する。

外部仕様を調べた場合は、取得日・出典・確度付きで`rag/raw/`へ保存し、統合記事と`rag/INDEX.md`を更新する。撤回済み資料やvendor効果量を製品根拠へ昇格させない。
