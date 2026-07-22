# ACE-062 dependency / affected-test provider 受入証拠

- 取得日: 2026-07-23
- 対象: `ace-062`
- 確度: focused testと関連回帰で確認済み

## 実装

- SwiftPMが生成した`.build/**/description.json`をbuild manifest worker入力として読み、source所属、module依存、dependent source、affected test、build targetを宣言edgeとして返す。
- 既存Make depfile providerは共有`ChangeImpactProvider`契約でdependencyとbasename一致test候補を返し、test候補は`naming_heuristic`／`heuristic`のまま保持する。
- SourceKit-LSP providerはchanged symbolのUTF-8 byte offsetをLSP positionへ変換し、semantic referenceをdependency／related test候補へ投影する。入力fileと返却locationは現在のSHA-256へ束縛する。
- semantic結果をlexical evidenceへ偽装しないため、公開schemaへ`semantic_reference`と`semantic_match`を追加し、順序を`heuristic < lexical_match < semantic_match < declared_edge`へ拡張した。
- optional providerをdefault routingへ入れる判断はACE-064のablationへ留保した。今回のproviderは明示注入で利用可能で、欠損manifest、stale SourceKit、未対応入力をtyped statusで返す。

## 検証

```text
BuildManifestChangeImpactProviderTests: 2 passed
ChangeImpactServiceTests: 9 passed
DepfileChangeImpactProviderTests: 4 passed
StaticImportChangeImpactProviderTests: 13 passed
MCPTypesTests: 7 passed
MCPRunCheckV2SchemaTests: 11 passed
```

fixtureではCore source変更から、依存App source、CoreTests、Core/App/CoreTests targetをbuild manifestの宣言edgeで復元した。SourceKit fixtureではsourceとtestの2 semantic referenceをそれぞれ現在file SHAへ束縛した。silent fallbackとprocessによるtest実行は行っていない。
