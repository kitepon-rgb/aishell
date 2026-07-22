# ACE-023c SearchContextService v2 evidence

- Lattice task: `ACE-023c`
- Date: 2026-07-23
- Production implementation provenance: `0465e91`、`afe10f6`
- Shared retained view predecessor: `9776af6`
- Benchmark freeze predecessor: `1bc8efa`

## 受入対象

`SearchContextService.swift`はfixed／regex／globを一requestで処理し、file identity・content SHA・byte rangeへ束縛した
canonical identityで重複を統合する。全queryは一つのcandidate列、`max_results`、JCS+LF byte budget、continuation snapshotを
共有する。changed/test rankingは`WorkspaceDeltaObservation`と同じeffective root、from/through cursor、project profile digestへ
束縛される。globはattested workspace indexだけを読み、index欠落時にfilesystem scanへfallbackしない。

continuationはintegrity protected tokenで、改変、retention失効、参照fileのidentity/SHA変更をtyped errorにする。
単一bundleがrequest budgetを超える場合はlossless artifact descriptorを返し、次offsetを必ず進める。

## 凍結request受入

`testFrozenBenchmarkV2FourQueryRequestHasCompleteCoverageAndNoDuplicateIdentity`はACE-006で凍結した次の4 queryを同じ順序、
同じranking、`max_results=500`、`byte_budget=65536`で一回のservice transactionへ渡す。

- fixed `needle`
- regex `export\\s+const`
- glob `src/**`
- glob `test/**`

全pageを連結し、期待3 path、4 query ID coverage、canonical identity重複0、各pageの共有budget内を独立検証した。
srcの同一byte rangeへ重なるfixed/regexは一matchへ統合され、query ID順も凍結入力順になる。

## focused verification

```text
swift test --filter 'SearchContextServiceTests|MCPContextV2WireTests'
Executed 9 tests, with 0 failures

node benchmarks/test-capability-benchmark-freeze-v2.mjs
benchmark v2 freeze: ok

git diff --check
exit 0
```

MCP wire gateはv1 input fieldを残したままv2 nested schemaをadvertiseし、成功結果
`aishell.search-context.v2`とtyped `INVALID_ARGUMENT`を確認した。benchmark計測と削減率の主張はPhase 2受入taskの責務であり、
この実装受入では行っていない。
