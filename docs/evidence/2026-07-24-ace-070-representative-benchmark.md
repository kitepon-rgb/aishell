# ACE-070 代表ベンチマークの実行と集計

- Date: 2026-07-24
- Lattice task: `ACE-070`
- Run: `benchmarks/results/representative-production-20260723-v10/`
- Attempt evidence: `/private/tmp/aishell-ace070-production-v10-attempts`

## 実行

3 arm（native / current-aishell-0.3.3 / candidate）× 32 task × 3 repetition = 288試行を
完走した。checkpointの288 recordは`result.json`のattemptsとバイト一致し、
`oracle-records.json`・`metric-records.json`とも一致する。同一試行の重複実行はない。

途中の中断とその扱い:

- 試行75: 不正なfinal agent JSONを、既存provider証拠から失敗試行として復元した。再実行していない。
- 試行146: setup時にcompanion helper未凍結で停止し、agent試行は未開始だった。helper凍結後に
  1回だけ実行してcheckpointへ記録した。

## 集計を止めていた検証器の不整合

集計は`attempt 120 candidate adapter trace is missing`の1件だけで`invalid`だった。一次証拠
（`mcp-wire/requests.bin`）では、候補は`workspace_snapshot`と`run_check`だけを呼び、必須の
`change_impact`を一度も呼んでいない。oracleも`solved=false`で
`required accepted outcome missing: change_impact:recommend`を出しており、adapter traceが
無いのは収集漏れではなく能力呼び出しが存在しないためだった。

phase 3 runnerは同じ状況を「tool非採用は正当な失敗試行であってharness証拠の欠落ではない」として
既にnullを許容していた。production runnerだけが一律に非nullを要求し、単一の失敗試行をrun全体の
invalidへ格上げしていた。production runnerをphase 3 runnerと同じ扱いに揃え、緩めっぱなしに
しないため「solvedと数える候補は必ず非null traceを持つ」という不変条件をoracleが結合される
集約段へ追加した（`solvedCandidateTraceViolation`）。

`result.json`はcheckpointから純関数で再導出した。attemptsはバイト単位で不変、statusと
invalidReasonsだけが再計算され、before/after SHAと根拠oracleをreceiptへ残した。288試行は
再実行していない。

- script: `benchmarks/reassemble-representative-result.mjs`
- receipt: `benchmarks/results/representative-production-20260723-v10/run/result-reassembly-receipt.json`
- status遷移: `invalid` → `valid`

## 集計で見つかった製品欠陥と修正

有効化後の集計で、correctnessに2件の退行が出た。一次証拠まで追うと、片方は製品欠陥だった。

- `change-set-atomic-success`: 候補は2ファイルを正しく原子的に適用していた（実ファイルの
  sha256が期待値と一致）。しかし`apply_change_set`の応答が`change_id`・`result="applied"`・
  `after_sha256`だけで書き込み後の内容を持たず、エージェントは報告に使える中身を持てずに
  `[change_id, "applied"]`を成果として報告して失敗していた。
- `change-set-stale-sha`: 候補2/3は出荷版0.3.3と同点で、候補固有の退行ではなかった。

修正は2段階。まず小さいテキストファイルに限り`after_content`で適用後の内容を返した
（`1beb6e6`）。これでも報告がぶれる回が残ったため、取引の`status="committed"`と情報が重複し
結論の顔をしていた変更ごとの`result`を落とした（`794b7ae`）。

## 修正後の再実行

`apply_change_set`を実際に呼ぶ候補試行は9件（`change-set-atomic-success`・
`change-set-stale-sha`・`bilingual-workflow-japanese`の各3 repetition）。合否で選ばず、
機械的にこの9件すべてを0.3.5バイナリで再実行した。

| task | 修正前 | 修正後 |
| --- | --- | --- |
| change-set-atomic-success | 0/3 | 3/3 |
| change-set-stale-sha | 2/3 | 3/3 |
| bilingual-workflow-japanese | 1/3 | 3/3 |
| 合計 | 3/9 | 9/9 |

再実行で塞いだharnessの穴も1件ある。wire tapするarmだけcodex内部呼び出しを`server=codex`の
2 toolに限定しており、エージェントが`codex_apps`の
`codex_document_control.list_document_sessions`を呼んだ瞬間にrunごと停止していた。native経路は
元からどのhost serverも許容している。server+toolの明示allowlistへ変え、aishell呼び出しの
厳格さは維持した。

## 集計対象の構成

最終集計は次の構成である。単一バイナリで通しの288試行を取り直したものではない。

- baseline 2 arm（192試行）: バイナリ無変更のためv10の記録をそのまま使う
- 候補87試行: v10の記録。`apply_change_set`を呼ばず、tool catalog digestも
  `a7fb8c...`で修正前後一致するため、今回の修正の影響を受けない
- 候補9試行: 0.3.5バイナリで再実行した記録

## Commits

- `1beb6e6` apply_change_set が適用後の中身を返すようにする
- `6fed7d3` 候補のtool非採用を正当な失敗試行として扱う
- `794b7ae` 変更ごとの冗長な適用状態を落として結果状態だけを返す
- `f59cbb9` 0.3.5へ更新する
