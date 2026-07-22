# ACE-064 provider ablation / stale-after-edit 受入証拠

- 取得日: 2026-07-23
- 対象: `ace-064`
- 確度: 再現可能fixtureによる局所比較。実SourceKit workerの性能値ではない。

## 同一fixture比較

変更入力は`Sources/Core/A.swift`のpath、SHA-256、symbol byte range。依存source、test、SwiftPM build manifestを同じworkspaceへ置いた。

| arm | 経過時間 | 追加できた根拠 |
|---|---:|---|
| filesystem lexical | 1.138 ms | lexical reference |
| fake SourceKit semantic | 2.823 ms | semantic dependency、related test |
| SwiftPM build manifest | 0.747 ms | declared dependency、related test、build target |

時間はtest process内の単回局所値であり、製品効果量として主張しない。実`sourcekit-lsp` handshakeはACE-061で別に95 msを確認済み。

## stale-after-edit

SourceKit query中に入力documentを書換え、workspace runtimeへ観測を投入した。結果はprovider report `stale`、reason `sourcekit_stale`、evidence 0件、freshness binding 0件だった。lexicalやcacheへfallbackして成功扱いしなかった。

## routing裁定

semanticとbuild manifestは候補品質を増やす。しかし現行ChangeImpactServiceにecosystem／入力別routerがなく、defaultへ足すと全requestで対象外providerまで試行する。このためdefaultはfilesystem + static-importのまま維持し、SourceKit、SwiftPM build manifest、depfileは利用可能だがdefault外とする。昇格条件は選択routerと実worker込みbenchmarkでtotal model tokenまたはwallの改善が確認できること。

## 検証

```text
testPhase6AblationSeparatesLexicalSemanticAndBuildEvidenceWithoutChangingDefaults: passed
testSourceKitEditDuringProviderQueryReturnsStaleWithoutEvidence: passed
```
