# CheckFreshnessCache production service 受入証拠

- Lattice ToDo: `ace-034a`
- Control task: `ace034a-check-freshness-cache`
- 実装commit: `63a201d`
- 受入日: 2026-07-22

## 実装した境界

- `off`はcache storeを観測せず、`prefer`と`only`は全step一括でhit又はmissを判定する。
- request固有identityをfreshness keyへ混ぜず、canonical bindingをSHA-256 keyへ変換する。
- bindingの実行後再照合、TTL境界、artifact retention、passed／normal failedだけのpublicationを実装する。
- manifestはclosed schema、entry全体hash、artifact size／SHA-256を検証し、破損をsilent miss又は自動削除へ丸めない。
- publicationは同一directoryの排他的tempへ完全writeし、file `fsync`、atomic `rename`、directory `fsync`の順で永続化する。
- quota、store failure、競合では部分entryを公開せず、期限切れ又は失効artifactだけを完全entry単位でevictする。
- restart後のhit、未知schema、manifest改変、artifact欠損／破損、無関係keyの破損もfail-closedで判定する。

## 検証

```text
swift test --filter CheckFreshnessCacheTests
Executed 20 tests, with 0 failures (0 unexpected)

git diff --check
exit 0
```

親監査では初稿から4回差し戻し、request identity混入、cold `off`によるstore観測、破損load後のsilent miss、期限切れquota占有、artifact参照の未束縛、欠損artifact再実行後のpublication消失、無関係な破損entryのsilent deleteを修正した。最終worker reportのdiff digestは`8225217e53d7885310f56125ae75243629017bfb13f0dd65e3e0b83498a9ab25`で、親が再計算したdiff digestと一致した。

既存の`ChangeSetSafetyNetTests.swift`に未使用戻り値warningがあるが、本変更のfocused suiteは成功している。このwarningは本ToDoの変更範囲外であり、検証失敗として扱っていない。
