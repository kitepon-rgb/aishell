# ACE-045 Phase 4受入証拠

- Date: 2026-07-23
- Lattice plan: `aishell-capability-expansion`
- Task: `ACE-045`
- Measurement: `docs/evidence/2026-07-23-ace-045-phase4-measurement.json`
- Measurement SHA-256: `f216f35ccb2cad1967b3b249368814564c1d03c3f317a9acaa43dd0144136f7a`
- Candidate binary SHA-256: `742f082d557b69435f4b2d2b510fc6382431a36a6e6eb68f016e54ac31339bcc`

## 結論

同一candidate binary、同一fixture、同一10秒workerでlegacy同期経路とexpanded非同期経路を比較し、Phase 4を受け入れる。

| 観測 | expanded candidate | legacy/polling baseline | 比率・判定 |
|---|---:|---:|---|
| incremental failure first useful | 48.930 ms | 10,160.566 ms | 0.00482、約99.5%短縮 |
| terminal wall | 10,083.654 ms | 10,160.566 ms | 0.99243、非悪化 |
| cancel terminal | 159.230 ms | natural worker 10,000 ms | `cancelled`、自然終了を待たない |
| external edit wall | 133.783 ms | 562.977 ms | 非悪化 |
| external edit call | wait 1 | poll 1 | 増加なし |

first usefulまでは4 tool round trip、terminalまでは10 round tripだった。legacy同期経路は1 callだが最初のfailureをterminalまで
公開しない。call数増を隠さず、first useful latencyとのtradeoffをそのまま記録した。

100ms external editは既存snapshotのdelivery grace内に入るためbaselineも1 pollで取得した。結果を見てfixture delayを変更せず、
このfixtureではround trip削減を主張しない。wall非悪化、changed path一致、silent fallback 0を受入値とする。

## 競合と完全性

- cancel応答はraceにより`cancelling`または`cancelled`を許し、その後のwaitで必ず`cancelled` terminalを確認する。
- terminal failureは完全stderr artifact SHA-256を返す。
- workspace waitは`state.txt`だけをchanged pathとして返す。
- frozen request revision 1のwire不整合は、測定前erratumとして別証拠へ記録した。

## 実行

```text
node benchmarks/test-capability-benchmark-freeze-v2.mjs
node --check benchmarks/phase4-acceptance.mjs
node benchmarks/phase4-acceptance.mjs \
  --binary .build/debug/aishell-mcp \
  --out docs/evidence/2026-07-23-ace-045-phase4-measurement.json
```

全assertion成功。provider modelを起動しないservice-level Phase gateなので、model token値は生成・推測していない。
