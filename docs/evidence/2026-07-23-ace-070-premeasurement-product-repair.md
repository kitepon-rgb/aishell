# ACE-070 測定前product repair証拠

- 取得日: 2026-07-23
- 対象: `ace-070`
- 確度: source、focused test、実MCP wireで確認済み

## 検出

288 attemptを開始する前の32 task preflightで、次の公開結線欠落を検出した。

- `search_context action=semantic`はMCP handlerが拒否し、凍結requestの`provider`と`cursor`も公開schemaに無かった。
- `DevelopmentRuntimeService`の既定`change_impact` providerはfilesystemとstatic-importだけで、実装済みのdepfile、
  SwiftPM build manifest、SourceKit providerをproduction runtimeへ登録していなかった。
- SourceKit-LSP workerは問い合わせ元1文書しか開かず、別fileのreferenceを`fresh`かつ0件で返していた。

## 修正

- `SemanticSearchContextService`を追加し、workspace cursor、root identity、file SHA、provider evidence artifactへ
  semantic結果を束縛した。stale、indexing、unavailableをtyped stateとして返し、lexical検索へ切り替えない。
- package metadataの無いSwift断片は、SourceKit provider内の明示engine
  `swift-frontend-semantic-batch`で`swiftc -typecheck -dump-ast`を直接起動し、compiler semantic referenceを返す。
  engine名はprovider evidenceの`reason`へ残し、黙ったbackend fallbackにしない。
- production `change_impact`へdepfile、SwiftPM build manifest、SourceKit providerを登録した。
- `search_context`の公開MCP schemaとhandlerへsemantic query、operation、provider、cursorを追加した。

## 検証

```text
swift test --filter MCPContextV2WireTests
Executed 6 tests, with 0 failures

swift test --filter SourceKitLSPServiceTests
Executed 4 tests, with 0 failures

swift test --filter SemanticSearchContextServiceTests
Executed 2 tests, with 0 failures

swift test --filter DepfileChangeImpactProviderTests
Executed 4 tests, with 0 failures
```

実MCP wire testはpackage metadataの無い2-file fixtureで`src/b.swift`のcross-file referenceを返すこと、
production runtimeがrequired provider `depfile`を受理してsource/test candidateを返すことを確認した。
