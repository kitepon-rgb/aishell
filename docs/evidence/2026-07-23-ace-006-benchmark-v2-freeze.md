# ACE-006 benchmark v2 freeze evidence

- Lattice task: `ACE-006`
- Date: 2026-07-23
- Scope: search context v2、managed process v2、workspace wait v2の統合実装前benchmark契約
- Freeze manifest: `benchmarks/capability-benchmark-freeze.v2.json`
- Freeze manifest SHA-256: `ec25c0a92e0134f8c8eb11b8d6c414dbf5a3df729ec38d00a5fdc8160ab`

## 凍結した面

- 5タスクの集合、3回反復、baseline/candidate arm、隔離条件
- fixtureの正確なbytesとSHA-256
- harness-only oracle。期待値はmodel-visible resultへ混入させない
- provider報告tokenを用いる`tokens per solved task`を主指標とした集計式。失敗試行も分子に含む
- search、managed process、workspace waitのrequest schemaとobserver projection schema
- v2専用materializerと、実path/cursorを注入したRFC 8785 JCS request bytes
- 凍結済みv1 suite、goal、execution contract、fixture、materializerのbyte lock

## 実cursor specimen

fixture rootは`/Users/kite/Developer/aishell/benchmarks/fixtures/capability-v2`。既存の統合前AIShell binary
`046df45ab842c2e37cc074a160183412f6e3ad52bcb06ee0f37b0b2fe8440843`へ、fixture rootだけを許可した隔離runtimeで
full `workspace_snapshot`を一回送り、次のcursorを取得した。

`ws2:7c0f7b9917d65dd9401dcff0087801ae40c9533b70cac02b36d48f7d41055545:17de79c6cf3ac7690fd4343766bef0188fec578f0ea5399a7ca9358a8cdccf8e:cb777755-8a2b-4416-ad4d-1554a0f5700e:0`

この実値とfixture rootをmaterializerへ渡したcanonical bytes、byte長、base64、SHA-256はfreeze manifestの
`specimen.requests`へ同時に固定した。search request SHA-256は
`cd1ae4d57065f89f8fc824177ee46fd5b75d19e9cf7f90b04bbdcdedd23a3ddd`。workspace wait request SHA-256は
`57edec5a6228afdaefbc395c3d0bfecec1047a1f58d564c6fe4bad167798d805`。

projection schema SHA-256:

- search: `164a554f9b09ae813746b18017a3e70f1ef25b3e996458fcb1d579c0dd85d9cb`
- managed process: `79c2feccc2bc35aa44a546aaf3638d978e62cf23d09b2a909dcc0bb068b6a728`
- workspace wait: `58765d0f6974e803c3619003fd93086072ae479748161392e5d9cbd8c5fe55b7`

## 検証

```text
node benchmarks/test-capability-benchmark-freeze-v2.mjs
benchmark v2 freeze: ok

node benchmarks/validate-representative-suite.mjs
status: valid, task_count: 32, total_planned_attempts: 288

git diff --check
exit 0
```

`test-capability-benchmark-freeze-v2.mjs`は全v2 artifact、fixture、materialized specimen、全v1 lockのbyte長とSHA-256を
再計算する。統合実装が凍結bytesを変更した場合は失敗する。

## 非実施

- search v2、`run_observe`、`workspace_wait`の候補実装は起動していない。
- baseline収集、candidate計測、効果量の主張は行っていない。
- v1 artifactと保存済みresultは変更していない。

契約変更が必要な場合は、このmanifestを上書きして通さず、別F revisionと再freezeを要求する。
