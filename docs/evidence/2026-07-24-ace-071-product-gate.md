# ACE-071 製品ゲート判定

- Date: 2026-07-24
- Lattice task: `ACE-071`
- 入力: ACE-070の代表ベンチ集計（`docs/evidence/2026-07-24-ace-070-representative-benchmark.md`）
- 集計入口: `benchmarks/representative-acceptance-aggregate.mjs`

## arm別実測

「解決task」は3 repetition全成功のtaskだけを数える。

| arm | 解決task | tokens / solved task | p50 wall (ms) | p95 wall (ms) |
| --- | --- | --- | --- | --- |
| native | 18 | 1,763,452 | 51,173 | 238,115 |
| current-aishell-0.3.3 | 15 | 1,789,186 | 51,149 | 96,369.25 |
| candidate (0.3.5) | 25 | 860,505 | 42,044.5 | 110,968.75 |

## ゲート判定

| 条件 | 実測 | 判定 |
| --- | --- | --- |
| baseline成功taskを落とさない | 退行 vs native: なし / vs current-0.3.3: なし | pass |
| tokens per solved task 30%以上削減（対native） | 51.20%削減 | pass |
| p50非悪化 | 42,044.5 <= 51,173 | pass |
| p95悪化10%以内 | 110,968.75 <= 261,926.5 | pass |
| silent fallback 0 | 0 | pass |

silent fallbackは候補arm全試行の禁止テレメトリ7項目
（silentFallbacks / silentTruncations / falseFresh / silentFullScans / partialWrites /
silentTextFallbacks / silentLexicalFallbacks）の合計で、v10分・再実行9試行分ともに0。

候補は解決task数でもnative 18・出荷版15に対し25で上回る。

## 判定前に解消した2件の退行

初回集計では退行2件でcorrectnessが不合格だった。いずれも一次証拠まで追って原因を確定した。

- `change-set-atomic-success`（vs current-0.3.3）: 製品欠陥。`apply_change_set`が適用後の内容を
  返さず、さらに冗長な`result="applied"`が結論の顔をしていたため、エージェントが実際の結果でなく
  状態を報告していた。0.3.5で修正し3/3へ回復した。
- `change-set-stale-sha`（vs native）: 候補2/3は出荷版0.3.3と同点で候補固有の退行ではなかった。
  0.3.5で3/3へ回復した。

未達を成功扱いにするための判定変更・oracle緩和は行っていない。集約段には逆に
「solvedと数える候補は必ず非null adapter traceを持つ」という不変条件を追加した。

## 集計対象の構成（再掲）

baseline 2 arm 192試行と候補87試行はv10の記録、候補9試行は0.3.5バイナリでの再実行である。
候補87試行は`apply_change_set`を呼ばず、tool catalog digestも修正前後で一致するため今回の
修正の影響を受けない。単一バイナリで通しの288試行を取り直したものではない。

## 結論

ACE-071の4条件（baseline成功task非減、tokens per solved task 30%以上削減、p50非悪化、
p95悪化10%以内、silent fallback 0）をすべて満たす。**製品ゲート合格**。
