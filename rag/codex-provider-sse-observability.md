# Codex provider SSEをbenchmark証拠へ使う

## 結論

Codex CLI 0.144.6の`--json` stdoutだけではactual provider modelを証明できない。一方、`RUST_LOG=tungstenite::protocol=trace`で得られるprovider WebSocket受信frameは`response.created`／`response.completed.response.model`を含むため、全response eventが同一modelでcompleted eventが存在する場合だけactual model evidenceとして採用できる。全targetの`trace`は認証情報を含み得るので使わない。

## fail-closed条件

- requested model、model cache、turn contextはprovider応答の代用にしない。
- `response.completed`がない、modelが空、複数modelが混在する場合は失敗する。
- evidenceはstdout provider traceと、stderrからbyte抽出した`response.created/completed`専用JSONLの両SHA-256へ結合する。全WebSocket trace行は通常stderr成果物へ保存しない。
- MCP structured resultはCodex JSONLの再serializationを使わず、MCP stdio透過tapが保存したoriginal response bytesから対象JSON valueのbyte sliceを抽出する。

## Phase 3 fixture側の独立blocker

provider観測を解消しても、manifestなしのfreshness/focused fixtureはproduction profileを生成できない。さらに現行npm providerはcheckを`npm run <kind> --`として作り、release経路ではcomplete input contractを生成せず`ineligible`にするため、manifestを足すだけではcache-hit受入にならない。productionで明示可能なclosed input contractを設計するか、凍結benchmarkのcommand／eligibilityを正式改訂する必要がある。

## 関連

- [[raw/openai-codex-provider-observability-2026-07-22]]
- [[development-efficiency-runtime]]
