# ACE-035 Phase 3 benchmark harness readiness

## 結論

Phase 3のproduction受入網と54 attempt実行基盤は実装・focused検証済み。初回preflightのactual provider model、MCP original bytes、production profile入力の全blockerを正規の製品／観測契約で解消した。release binaryを使うsingle candidate preflightも成功した。ただし54実model attemptとexternal oracle aggregationは未実施であり、ACE-035およびPhase 3は未受入のまま維持する。

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
- executorは実binary SHA、MCP `initialize`/`tools/list` raw bytes、workspace bytes、prompt、sandbox、host catalog、actual provider model evidenceをattemptごとに照合・保存する。actual modelは秘密を含み得る全target traceを使わず、`RUST_LOG=tungstenite::protocol=trace`のprovider WebSocket受信frameにある`response.created/completed.response.model`が全eventで一致する場合だけ採用する。対象frame JSONだけをstderrからbyte抽出した専用JSONLとstdout provider traceの両SHA-256へ結合し、WebSocket trace行自体は通常stderr成果物へ保存しない。
- Codexが起動するAIShell MCPの前段に透過wire tapを置き、request/response stdio bytesを変更せず保存する。structured resultはoriginal JSON-RPC response内のvalue byte rangeを抽出し、retained artifactはwire descriptorのhandle、size、SHA-256と照合する。
- aggregatorはrunner-validな54 attemptとexternal oracle、observer metrics、executor evidenceをexact joinする。failed attempt tokenもnumeratorへ含め、zero successは`positive_infinity`、task solvedは3反復全成功とする。
- current/candidate/native間のcorrectness regression gateを持つ。
- oracle値はsetup DTO、prompt、request、manifest、traceから除外する。

## arm freeze

| arm | commit | release binary SHA-256 | tools catalog |
| --- | --- | --- | --- |
| current-aishell-0.3.3 | `2705b407cde704873c40b833507059eba99a1a82` | `982b9a3d07a358440937acecc6535063f7e9691dd8f8a8ae0368dcf7a0b43c4c` | 7 tools, digest `9b539dc63e48868152fadd59a575325464af1b67b64826032daf1a27af1f0b36` |
| candidate | `a4cd9ae9a3150757400c9ba5a2657923ae0c5499` | `c6fc0ed4e0a906446c8ba5c04ec68dc3534638804e6ddea54b2b226f74fdf560` | expanded 9 tools, digest `f48911143c4202f0364ca765a2bdfb35c18ffbcada5fa156193f716962aadc58` |

current armは隔離worktreeから、candidate armは上記commitの製品sourceをrelease buildして固定した。candidateのbinary/catalog digestはblocker解消後に実MCP `initialize` / `tools/list` から再採取済み。

## focused verification

- `Phase3AcceptanceTests`: 6件成功
- ProjectProfileServiceTests: 23件成功、DevelopmentRuntimeServiceTests: 3件成功
- capability materializer/oracle/observer、representative runner、Codex executor、acceptance aggregator、production harness、local callbacks、MCP wire tap: 9 test file成功
- executor self-test: 63 fake invocation、うち54 attemptの統合経路成功
- production harness self-test: runner → executor → observer → oracle → aggregatorの54 attempt統合成功
- static import provider: 13件成功
- production v2 adapter: 13件成功
- materializer: 32 task valid
- Node syntax、JSON schema、`git diff --check`: 成功
- release package build: 成功
- actual release binary＋actual MCP single candidate preflight: exact profile/check解決、`miss_executed`、process 1、publication 1で成功
- candidate capabilityは`AISHELL_TOOL_PROFILE=development`と`AISHELL_CAPABILITY_SET=expanded-v1`を分離して注入する。`expanded-v1`をtool profileへ誤投入して7-toolへ縮退する配線をfreeze採取時に検出し、正規の9-tool catalogへ修正した。
- destructive annotation付きMCPを`approval_policy=never`で黙ってcancelしていた実Codex preflightを受け、全arm共通の`workspace-write`・network offを維持したまま、公式の非対話経路である`on-request`＋`approvals_reviewer=auto_review`をrun isolationへ固定した。dangerous bypassは使わない。
- read-only反証のenvironment closure、npm shell迂回、NUL fail-late、profile environment失効を修正し、最終再監査で確実なP0–P2残存なし

fake process/MCPを使うself-testは実model成功を主張しない。

## 解消したpreflight blocker

1. Codex CLI 0.144.6のstdout JSONLにはactual provider modelがなかったが、provider WebSocket受信frameにactual `response.model`とusageが存在することを実測し、`response.created/completed`だけをbyte抽出した専用provider SSE JSONLへのbinding付きparserを追加した。requested `gpt-5.6-sol`は引き続き代用しない。
2. Codex JSONLはMCP resultをhost objectへ変換するが、透過stdio tapでAIShellのoriginal JSON-RPC bytesを保持できることを実Codex＋実AIShellで確認した。canonical再serializationは使わない。
3. 実probeでharnessの`runtime.json.updatedAt`が不正形式だったことも発見し、固定ISO 8601値へ修正した。
4. `aishell.package-profile.v1`を製品契約として追加し、direct Node argv、closed relevant inputs、environment key集合、`project_root_closed` effectをpackage manifestから明示できるようにした。通常npm scriptは引き続きcache ineligibleであり、`npm` executable、未知field、root escape、NUL、不正environment keyをmanifest parse時に拒否する。
5. freshness/focused fixtureへproduction manifestを追加し、fixture catalog SHAを正式改訂した。oracle、task、scenario mutation、prompt、execution contractは変えていない。合成catalog/checkは使わない。
6. production wireでは`lookupEvidence.ineligibilityReason`がnil時にfield自体を省略するため、harness validatorを現行Codable wireへ合わせた。値の意味検証は維持する。

## 次の実行gate

上記freezeを入力として54実model attempt、external oracle aggregationの順で実行する。preflight blockerは残っていない。
