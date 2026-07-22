# ACE-065 Phase 6受入証拠

- Date: 2026-07-23
- Lattice task: `ACE-065`
- Candidate binary SHA-256: `12dfcb5bccfecca170f1e0b1603437bb74a89fe7da5272209fb8d2bfcaac0160`
- Probe contract SHA-256: `1f97231b52e837973ecefbad42c75422248e631083691a9d4b8e326f96597542`
- Model: `gpt-5.6-terra`, reasoning `low`
- Codex: `codex-cli 0.144.6`

## 結果

expanded development profileは高密度9 toolと復旧control 2 toolを契約順で返し、expanded full profileは
先頭11 toolを同じ順に保った29 toolを返した。baseline development 7 toolとbaseline full 25 toolは変えていない。
initialize instructionsと9 tool descriptionは日英で、自律選択、shell/nativeより優先する条件、no-call条件を明示した。

日英20 discovery probeは20/20、誤routing 0、期待tool後の不要call 0だった。18 positiveで期待toolを各1回、
2 no-call controlで0回を確認した。schema上必要な期待tool前の補助callは合計3回で、英日`run_check`と
日本語`search_context`の前に各1回`workspace_snapshot`が選ばれた。全21 callのtrace、prompt、model条件、
Codex JSONL/stderr SHA-256は
[`data/ace-065-tool-discovery-model-results.json`](data/ace-065-tool-discovery-model-results.json)へ固定した。

discovery gateはproduction binaryのtool名、順、日英description、initialize instructionsを使い、引数schemaだけを
空objectへ正規化して実処理を起動しない。schemaとwire互換はSwift test、native shellとの競合はPhase 7の
tool adoptionで別に受け入れる。

## 検証

- `swift test --filter MCPRunCheckV2SchemaTests`: 11/11
- `swift test --filter MCPTypesTests`: 7/7
- `swift test --filter MCPRunCheckV2WireTests/testLegacyAndV2DirectReachRuntimeWithoutChangingV1Shape`: 1/1
- `node benchmarks/validate-tool-discovery-probes.mjs`: 9 tool、20 probe valid
- `node benchmarks/test-tool-discovery-evaluator.mjs`: 9 case、oracle leakage 0
- `node benchmarks/run-tool-discovery-model-probes.mjs --model gpt-5.6-terra --concurrency 4`: 20/20、誤routing 0、不要call 0
- debug MCP smoke: baseline 7、baseline full 25、expanded 11、expanded full 29。expandedの先頭9はADR 0003順。
