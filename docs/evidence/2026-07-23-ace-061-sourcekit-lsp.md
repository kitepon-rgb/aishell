# ACE-061 SourceKit-LSP worker 受入証拠

- 取得日: 2026-07-23
- 対象: `ace-061`
- 確度: 実装と実プロセス試験で確認済み

## 実装

- `SourceKitLSPService`がworkspace cursorと問い合わせ元documentのSHA-256を問い合わせ前後で検証する。
- definition、references、workspace symbolsを`/usr/bin/xcrun sourcekit-lsp`へshell評価なしで送る。
- 返却locationごとに現在の対象file SHA-256を付与する。
- 問い合わせ中の編集は`stale`、index構築中は`indexing`、worker不在・timeout・未保持sessionを要するdiagnosticsは`unavailable`として明示し、lexical fallbackを行わない。
- LSP stdioは`Content-Length` frameをPipeの到着済みdata単位で読み、各requestを10秒で停止する。実装途中に発見した64 KiB待ちのblocking readは除去した。

## 検証

```text
swift test --filter SourceKitLSPServiceTests
Executed 4 tests, with 0 failures
```

実`sourcekit-lsp` initialize + workspace/symbol handshakeは95 msで完了した。fake worker試験では、locationのSHA束縛、問い合わせ中編集の`stale`化とfallback不在、`indexing`／`unavailable`の区別を確認した。

## 制約

diagnosticsはLSPのpush通知を受け続ける保持sessionが必要であり、今回のrequest-scoped workerでは`unavailable`を返す。未実装を別検索で代替せず、公開状態として明示する。
