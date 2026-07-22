# ACE-006 benchmark v2 freeze erratum

- Date: 2026-07-23
- Original task: `ACE-006`
- Freeze revision: 2
- Manifest SHA-256: `b9e1acb1d120135ee577ff8b2fd9fb9f14cc0a376d904a88317c4714bc77a4c7`

## 修正理由

Phase 4の最初の実candidate計測を開始した時点で、revision 1のmanaged process requestが、このhostに存在しない
`/usr/bin/node`を固定して`EXECUTABLE_NOT_ALLOWED`になった。またworkspace wait requestが公開済みschemaの
`from_cursor`ではなく、未実装の`cursor`と`change_limit`を固定していた。

これはcandidate性能やoracle結果を見る前に確定したwire不整合であり、別経路やsilent fallbackでは実行しない。revision 2では
AIShellがPATHから絶対実体へ解決・記録する`node` basenameと、公開schemaどおりの`from_cursor`へ修正した。

## 不変条件

- 5 task、3 repetition、arm、隔離条件は不変。
- fixture bytes、10秒worker、100ms external edit、event gapは不変。
- harness-only oracleとaggregationは不変。
- v1 lockは不変。
- 修正後の最初の計測結果に合わせてdelay、閾値、expected resultを変更していない。

## 検証

```text
node benchmarks/test-capability-benchmark-freeze-v2.mjs
benchmark v2 freeze: ok
```

materializer source、canonical request byte length、SHA-256、base64をmanifest revision 2へ同時に固定した。
