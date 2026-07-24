# ACE-070 erratum: 非同期プロセス2 taskの測定欠落と補完

- Date: 2026-07-24
- 対象: `docs/evidence/2026-07-24-ace-070-representative-benchmark.md` と
  `docs/evidence/2026-07-24-ace-071-product-gate.md` の訂正・補完
- 一次証拠: `benchmarks/results/representative-production-20260723-v10/rerun-0.3.6-async/`
  （probe-async2.json SHA256 `b93bee6956259b64b4a534a216246eaeba15666141ccd8495c22ab6edd00f41e`）

## 欠落の事実

v10本走で、`async-process-first-useful-result`と`async-process-cancel`の候補6試行
（seq 127/130/133/137/140/142、07-23 21:48〜22:06実行）は、companion binary
`aishell-run-supervisor`の凍結（07-23 22:15）より**前**に走っていた。6試行すべてが
`EXECUTABLE_NOT_ALLOWED`（凍結先に実行ファイルが存在しない）で必須capabilityを
起動できておらず、**この2 taskは製品を一度も測定していなかった**。

- 製品の責任ではない。存在しない実行ファイルの拒否は正しい挙動である。
- ベンチ全体への影響は候補を不利にする方向のみ（無駄tokenが分子に乗る）。baseline
  2 armもこの2 taskは0/3であり、correctness gateの判定は変わらない。
- 従前のace-070/071証拠はこの欠落に言及しておらず、その点が不正確だった。

## 補完測定

supervisor凍結後、同6試行を機械的に全再実行した（選り好みなし）。

1回目（0.3.5、`run_observe`が終端の結果状態を返す前）: **1/6**。
機構は全て動作（start/observe/wait/cancelの成功呼び出しを確認）したが、
`run_observe`応答が`terminationCause`を文字列に潰し、exit code本体とcancel受理の
明示を返さないため、検収基準（terminalExitCode・cancelAcknowledged）を満たせなかった。
`apply_change_set`（0.3.5で修正）と同一の欠陥類型である。

2回目（`a4e0179`修正後=0.3.6: `exitCode`/`signal`/`cancelAcknowledged`を応答へ追加）: **5/6**。

| task | 欠落時 | 0.3.5 | 0.3.6 |
| --- | --- | --- | --- |
| async-process-first-useful-result | 測定なし(0/3) | 0/3 | **3/3** |
| async-process-cancel | 測定なし(0/3) | 1/3 | **2/3** |

残る1失敗（seq142 rep3）は、1本目のrunがcancel到達前に自然終了し（toolは
`state="failed"`と正直に応答）、エージェントが2本目を起動してcancelに成功した
timing事例で、製品欠陥ではない。

## 訂正後の最終ゲート

| arm | 解決task | 解決試行 | token/解決task | p50 (ms) | p95 (ms) |
| --- | --- | --- | --- | --- | --- |
| native | 18 | 60 | 1,763,452 | 51,173 | 238,115 |
| current-aishell-0.3.3 | 15 | 53 | 1,789,186 | 51,149 | 96,369 |
| candidate (0.3.6) | **26** | **86** | **838,768** | 42,045 | 106,418 |

- token削減 **52.44%**（対native、≥30% pass）
- p50非退行 pass / p95≤native×1.10 pass / 退行なし / silent fallback 0
- **製品ゲート: 合格**（従前判定を維持、数値は改善）

集計構成: baseline 192試行と候補81試行はv10記録、候補9試行は0.3.5再実行、
候補6試行は0.3.6再実行。

## 再発防止

- harness手順: companion binaryはrun開始時にmain binaryと同時凍結する（今回の欠落は
  凍結が後追いだったことが原因。`1f7f3c8`で凍結自体は導入済みだが、順序の保証が要る）。
- 製品設計: 副作用型・プロセス型toolは終端の結果状態を返す
  （`rag/side-effect-tool-result-state.md`）。0.3.5で`apply_change_set`、0.3.6で
  `run_observe`に適用した。
