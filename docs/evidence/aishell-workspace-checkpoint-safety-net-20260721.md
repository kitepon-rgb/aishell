# Workspace checkpoint先行安全網

- Date: 2026-07-21
- Lattice task: `ACE-011`
- Contract: `docs/adr/0006-persistent-workspace-checkpoint-contract.md`

## 固定内容

`Tests/AIShellCoreTests/Fixtures/workspace-checkpoint-cases.v1.json`へ12 scenarioを固定した。

- cold startと正常warm restore
- offline modify、同一size/mtimeへ戻された変更、create/delete/rename
- FSEvents gapとroot identity置換
- corrupt payload、unsupported schema、migration失敗
- per-root quota超過とatomic replace失敗時の旧checkpoint保存

`benchmarks/validate-workspace-checkpoint-safety-net.mjs`はscenarioの欠落・重複、stop時のtyped error、
silent entry再利用、corrupt/quota/write失敗時の旧証拠破壊を検査する。ACE-012aのSwift focused testはこのfixtureを
同じ期待値で消費し、test内だけの代替storeやskipへ置き換えない。

## 検証

```text
$ node benchmarks/validate-workspace-checkpoint-safety-net.mjs
{"schema":"aishell.workspace-checkpoint-safety-net-result.v1","cases":12,"required_cases":12,"silent_fallbacks":0,"status":"passed"}

$ git diff --check -- benchmarks/validate-workspace-checkpoint-safety-net.mjs Tests/AIShellCoreTests/Fixtures/workspace-checkpoint-cases.v1.json
(no output)
```

production Swiftは変更していないため、このtaskでは`swift test`をスキップした。store実装とfocused Swift testは
ACE-012a、observation journalはACE-012b、runtime統合はACE-012の所有範囲である。
