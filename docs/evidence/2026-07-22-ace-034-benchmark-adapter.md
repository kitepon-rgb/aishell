# ACE-034 production v2 benchmark adapter evidence

## 対象

- 実装commit: `b9ddb992bbb7665157debc52665385d20bab0716`
- 目的: 凍結済みbenchmark v1要求を、production v2の公開契約へ情報欠落や意味の置換なしで接続する。
- 非対象: 凍結fixtureの変更、caller supplied catalog、direct commandへのcache適用、depfile providerの既定登録。

## 凍結入力の不変性

| 入力 | SHA-256 |
| --- | --- |
| representative suite | `201958f03dc3b85ea6bfe9cca3b5edfec88124da8a790539639465fab8f46cf7` |
| capability fixtures | `630680d817d8fbc767072efde5844027534c0de4536fa301ecd0e9165637d5b9` |
| representative task goals | `810103d0f1358685db035f6f1f711895f411c21e15ba0f8b9de1c3a6761d8e5d` |
| representative execution contracts | `aa02c3d604dbad28c182ff9ae1df836b7781d671b199a48f3df3e7a4fe3f6163` |

凍結4ファイルは実装commitの変更対象に含まれない。

## 実装した境界

- adapterはtrusted setupのcanonical absolute `root`と`rootIdentity`を要求し、`root`だけをproduction v2 requestへ渡す。`rootIdentity`はsetup digestに束縛する。
- `change_impact`はchanged pathのSHAまたは期待された不存在とprovider IDを厳密に結合する。unknown edge、artifact mismatch、raw result bytes欠損・不一致はfail-closedとする。
- `recommend`はproject/profileをproduction側で解決し、callerがselection digestやcatalogを捏造できない。
- `run_check`はtrustedな`profile_check`だけへ変換し、direct invocationやdirect cacheへ退行しない。
- traceはstage順、canonical input bytes、productionが返したexact result bytes、そのSHA-256、artifact、token chainを保持する。
- production resultの`continuation`は常に公開schemaどおり明示的な`null`をencodeし、provider report/evidenceから非公開余剰fieldを除いた。

## provider

- `static-import`はJS/TSのrelative import/export/dynamic importと、明示CommonJS拡張子のrelative `require`を逆推移解析する。
- 非literal dynamic import、非literal CommonJS、module kind未解決の`.js/.ts` `require`、未対応言語input、expected-absent input、探索上限は明示coverage gapへ閉じる。
- `depfile`はMake depfileの継続行とescaped spaceを解析し、source dependencyとtest naming heuristicを区別する。欠損・削除・depfile自体の変更はgapへ閉じる。
- depfile providerはPhase 3の既定providerに登録しない。後続Phase 6での導入までexplicit injectionだけを許し、現時点のcoverageを水増ししない。

## 検証

- `StaticImportChangeImpactProviderTests`: 13件成功
- `DepfileChangeImpactProviderTests`: 4件成功
- `ChangeImpactServiceTests`: 8件成功
- `MCPRunCheckV2WireTests`: 4件成功
- `MCPRunCheckV2SchemaTests`: 11件成功
- `test-production-v2-benchmark-adapter.mjs`: 13件成功
- capability request materializer self-test: 32 task valid
- `git diff --check`: 成功

read-only反証監査で指摘されたmixed-language coverage、changed depfile、CommonJS、探索上限、exact raw bytes、公開schema余剰fieldを修正した。最終再監査では確実なP0–P2残存なし。
