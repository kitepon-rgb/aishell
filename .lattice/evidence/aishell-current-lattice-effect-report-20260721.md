# 最新Lattice効果測定 — AIShell

- 測定日: 2026-07-21
- AIShell HEAD: `2705b407cde704873c40b833507059eba99a1a82`
- Lattice HEAD: `16b7b1b43c77788a6c902af6510a3115c03ff753`
- 機械証拠: `aishell-current-lattice-effect-measurement-20260721.json`
- 旧Codegraph入力: 不使用

## 結論

最新v5の主効果は、Phaseを消したり監査を増減したりせず、Phase監査待ちを通常ToDoのscheduleへ
暗黙伝播させなくなったことにある。

同一3-ToDo・2-Phase fixtureでは、Phase 2がどちらも監査上`locked`のまま、初期`next_ready`が
v4の`[T1]`からv5の`[T1, T2]`へ増えた。`T3`は明示Phase accept dependencyを持つため候補にならない。
したがって、独立作業だけを解放し、明示した監査境界は維持している。

AIShell実graphは49 ToDo、48 hard dependency、join由来20 edge、既存8 Phase、明示Phase accept dependency
1件である。ToDo DAG単体は24 round、最大task幅11。同じPhase定義をv4暗黙gateとして合成すると28 round、
v5分離gateでは26 roundとなり、抽象依存roundを2、比率で7.143%削減した。Phase数の変更は0である。

この7.143%はgraph roundの削減率であり、実時間、工数、model tokenの削減率ではない。

## current bundled sensorによるfresh測定

AIShellの既存`.codegraph`は読まず、`.codegraph`を含まないfresh cloneを作成した。そこで現在の
`/Users/kite/Developer/Lattice/bin/lattice.mjs`からbundled sensorを新規initし、生成直後の索引だけで
syncとcompileを行った。公開receiptは`provider=lattice`、`sensor_owner=lattice`、
`sensor_version=0.7.3-lattice.1`、status `ok`。

- 8 ToDo / executor 4: 2 wave `[4,4]`、minimum feasible 2、conflict 0、unknown 0、not-ready graph evidence 0
- 2 ToDo / executor 2: 1 wave `[2]`、minimum feasible 1、conflict 0、unknown 0、not-ready graph evidence 0

安定項目はfresh cloneからもう一度独立実行し、duration項目を除いたJSONが一致した。

## 敵対的検証と限界

1. compile requestのboundaryは手書き入力を含むため、`conflict=0`だけで境界の完全な正しさは証明しない。
   今回確認できたのは、fresh索引上のgraph evidenceが全件readyで、unknownなしに同じscheduleへ収束したこと。
2. init/sync/compileのdurationは各一回の参考値で、性能効果として主張しない。
3. bundled sensorは公開identityをLatticeへ切替済みだが、fresh initでも`.codegraph/codegraph.db`を生成し、
   bundled helpと一部診断にCodeGraph名称が残る。今回は新規生成物だけを使ったため旧データ依存ではないが、
   sensor内部の名称・保存先cutover完了は主張できない。
4. 既存AIShell上の過去sensor sync成功は旧`.codegraph`の影響を排除できないため、今回の根拠から棄却した。

## 判定

- Phase監査分離の効果: 確認できた
- 既存Phaseの維持: 確認できた（8→8）
- 明示Phase gateの維持: 確認できた
- fresh Lattice compileの再現性: 確認できた
- 実時間・token削減: 未測定
- sensor内部のCodegraph完全廃止: 未達
