# AIShell Phase 0 gate evidence

- Date: 2026-07-21
- Base HEAD: `2705b407cde704873c40b833507059eba99a1a82`
- Lattice plan version: `rev-a4f1cb69ad348f1c553d7e2c`
- Lattice journal head after evidence re-promotion: `828b6300f7f14ce2f28165a20fb435f65c2d34c728cd61616dce64a231e17eef`

## Critic decision

独立refuterは、request template値のfixture束縛、3 armの構造的公平性、discovery oracle隔離、
余計なcallの扱い、workspace cursorのrename/delete/gap/retentionを実ファイルから再監査した。
最後に残ったsemantic probe ID漏洩を修正後、ACE-002/003/004を含む内容面blocker 0、Phase 0受入可と判定した。

## Full regression

- `swift test`: 50 tests、failure 0
- `WorkspaceStateRuntimeTests`: 15 tests、failure 0
- `node benchmarks/validate-representative-suite.mjs`: 32 task、16 fixture、3 arm、288 attempt契約 valid
- `node benchmarks/test-capability-request-materializer.mjs`: 32/32 task valid
- `node benchmarks/test-capability-oracle.mjs`: 3 cases valid
- `node benchmarks/test-capability-observer.mjs`: 9 positive / 12 negative valid
- `node benchmarks/validate-tool-discovery-probes.mjs`: 20 probes、18 positive、2 no-call valid
- `node benchmarks/test-tool-discovery-evaluator.mjs`: 6 cases、oracle leakage 0
- `git diff --check`: green
- `lattice todo verify --plan aishell-capability-expansion --json`: snapshot stale false、reconciled、active task 0

## Lattice maintenance wave

AIShell運用中に見つけたLatticeの不満は保留せず根治した。

- 0.11.0: project別live Ganttを`/projects/<project_id>/`へ分離し、AIShellとLatticeを独立URL・独立sessionで同時表示可能にした。
- 0.11.1: `lattice todo reopen --help`等のsubcommand helpを正規option付きで公開した。
- 両変更ともdocs、focused test、full CI、対象限定commit、main push、npm publish、registry版global install、実動作確認を完了した。
- gate時点で`lattice --version`と`npm view @quolu/lattice version`はともに`0.11.1`。
- `lattice todo list`の失敗は既存の正規構文`lattice todo status --json`を私が取り違えた操作ミスであり、重複aliasは追加していない。

maintenance候補の持越しは0件である。

## Scope preservation

Phase 0で意図的廃止は0件。既存5 tool、復旧control 2本、full profile legacy 20 primitive、
S〜B capability、32代表task、20 discovery probe、3 arm比較を維持した。
削減対象は重複scan、重複tool call、無効なpoll、証拠の二重化だけである。
