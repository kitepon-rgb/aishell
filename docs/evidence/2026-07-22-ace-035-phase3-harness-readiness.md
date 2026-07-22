# ACE-035 Phase 3 benchmark harness readiness

## 結論

Phase 3のproduction受入網と54 attempt実行基盤は実装・focused検証済み。ただし、凍結比較条件を満たす実model runはpreflightで3つの外部／入力blockerが確認されたため未実施であり、ACE-035およびPhase 3は未受入のまま維持する。

requested model名、合成profile、canonical再serializationを証拠の代用にしない。

## 実装commit

- `c286561`: Phase 3 production受入testの初版
- `d08fcef`: 54 attempt runner、Codex executor、oracle aggregator
- `a6d9bdf`: production harnessとobserver/oracle接続
- `53fb6bd`: local Codex/AIShell callbacks

## production受入網

`Phase3AcceptanceTests`は凍結Phase 3の6 scenarioをproduction serviceへ通す。

- repeated check: 2回目process 0、cache hit、同一source run/artifact
- relevant input edit: digest変化後は旧resultを再利用せず再実行
- direct/transitive impact: multi-file candidate dedupeと全provenance保持
- unresolved dynamic edge: coverage gapを返しsilent completeしない
- focused recommend-only: candidateを返すがprocess 0
- focused explicit-run: callerの明示選択後だけ実行しrequested=plannedを維持

## benchmark harness

- Phase 3の6 task × 3 arm × 3 repetition = 54 attemptを固定seed順で生成する。
- provider usageはraw JSONLの凍結carrierから再抽出し、recordとのexact一致を要求する。欠損・未知形式・自己申告差異はrun全体をinvalidにする。
- candidate adapterはfrozen request、trusted setup、original production result bytes、artifactからproduction adapterを再実行し、v2 requestとprojectionを意味的にもexact照合する。
- executorは実binary SHA、MCP `initialize`/`tools/list` raw bytes、workspace bytes、prompt、sandbox、host catalog、actual provider model evidenceをattemptごとに照合・保存する。
- aggregatorはrunner-validな54 attemptとexternal oracle、observer metrics、executor evidenceをexact joinする。failed attempt tokenもnumeratorへ含め、zero successは`positive_infinity`、task solvedは3反復全成功とする。
- current/candidate/native間のcorrectness regression gateを持つ。
- oracle値はsetup DTO、prompt、request、manifest、traceから除外する。

## arm freeze

| arm | commit | release binary SHA-256 | tools catalog |
| --- | --- | --- | --- |
| current-aishell-0.3.3 | `2705b407cde704873c40b833507059eba99a1a82` | `982b9a3d07a358440937acecc6535063f7e9691dd8f8a8ae0368dcf7a0b43c4c` | 7 tools, digest `9b539dc63e48868152fadd59a575325464af1b67b64826032daf1a27af1f0b36` |
| candidate | `a6d9bdf` | `203ab4044b9140255ac4ccd5a0f8cecdad466d47735083fd6ac9c084d510a8b9` | expanded 9 tools, digest `6e421587fb8e5e6e60d81f5b079739f485e02defc9c3bd44fe3a40e6d76c09f6` |

両armは隔離worktreeからrelease buildした。candidate実行commitはblocker解消後に再freezeし、binary/catalog digestを再採取する。

## focused verification

- `Phase3AcceptanceTests`: 6件成功
- representative runner、Codex executor、acceptance aggregator、production harness、local callbacks: 5 test file成功
- executor self-test: 63 fake invocation、うち54 attemptの統合経路成功
- production harness self-test: runner → executor → observer → oracle → aggregatorの54 attempt統合成功
- static import provider: 13件成功
- production v2 adapter: 13件成功
- materializer: 32 task valid
- Node syntax、JSON schema、`git diff --check`: 成功
- 最終read-only反証: 確実なP0–P2残存なし

fake process/MCPを使うself-testは実model成功を主張しない。

## 実行blocker

1. Codex CLI 0.144.6のpreflight JSONLは`thread.started`、`turn.started`、`item.completed`、`turn.completed.usage`を返したが、actual provider model snapshot metadataを返さなかった。requested `gpt-5.6-sol`はactual evidenceの代用にしない。
2. 凍結freshness-cache/focused-pipeline fixtureはproject manifestを含まず、production ProjectProfileServiceがprofile/checkを生成できない。合成catalog/checkは禁止する。
3. Codex JSONLがMCP structured resultのoriginal bytes、change-impact raw pages、complete artifactをlosslessに保持する保証がない。canonical再serializationは禁止する。

いずれかが解決するまでは54 model attemptを開始しない。解消後はcandidate commitを再freezeし、1 attempt preflight、54 attempt、external oracle aggregationの順で実行する。
