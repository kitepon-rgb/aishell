# ACE-035 Phase 3 benchmark harness readiness

## 結論

Phase 3のproduction受入網で54 attemptを完走し、observer契約修正後のexternal oracle aggregationはvalid、correctness gate通過、candidate 6 task・18 attemptすべて成功した。native/currentの既存成功taskに対するregressionは0。release candidateはcommit `873d2bc7b5acba9c1286847c39612048338f1530`、binary SHA-256 `046df45ab842c2e37cc074a160183412f6e3ad52bcb06ee0f37b0b2fe8440843`へ固定した。

requested model名、合成profile、canonical再serializationを証拠の代用にしない。

## 実装commit

- `c286561`: Phase 3 production受入testの初版
- `d08fcef`: 54 attempt runner、Codex executor、oracle aggregator
- `a6d9bdf`: production harnessとobserver/oracle接続
- `53fb6bd`: local Codex/AIShell callbacks
- `7e4f4d3`: auto-reviewer込みprovider evidence v3、timeout失敗記録、実試行observer閉包

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
| current-aishell-0.3.3 | `2705b407cde704873c40b833507059eba99a1a82` | `982b9a3d07a358440937acecc6535063f7e9691dd8f8a8ae0368dcf7a0b43c4c` | 7 tools, digest `0491fd1024fc3a34b871c6d3cf1aabff6fce4ed2539d974f3a604d4c4ee45361` |
| candidate | `873d2bc7b5acba9c1286847c39612048338f1530` | `046df45ab842c2e37cc074a160183412f6e3ad52bcb06ee0f37b0b2fe8440843` | expanded 9 tools, digest `f48911143c4202f0364ca765a2bdfb35c18ffbcada5fa156193f716962aadc58` |

current armは隔離worktreeから、candidate armは上記commitの製品sourceをrelease buildして固定した。candidateのbinary/catalog digestはblocker解消後に実MCP `initialize` / `tools/list` から再採取済み。

## focused verification

- `Phase3AcceptanceTests`: 6件成功
- ProjectProfileServiceTests: 23件成功、DevelopmentRuntimeServiceTests: 3件成功
- capability materializer/oracle/observer、representative runner、Codex executor、acceptance aggregator、production harness、local callbacks、MCP wire tap: 9 test file成功
- executor self-test: 64 fake invocation、うち54 attemptの統合経路成功
- production harness self-test: runner → executor → observer → oracle → aggregatorの54 attempt統合成功
- static import provider: 13件成功
- production v2 adapter: 13件成功
- materializer: 32 task valid
- Node syntax、JSON schema、`git diff --check`: 成功
- release package build: 成功
- actual release binary＋actual MCP single candidate preflight: exact profile/check解決、`miss_executed`、process 1、publication 1で成功
- candidate capabilityは`AISHELL_TOOL_PROFILE=development`と`AISHELL_CAPABILITY_SET=expanded-v1`を分離して注入する。`expanded-v1`をtool profileへ誤投入して7-toolへ縮退する配線をfreeze採取時に検出し、正規の9-tool catalogへ修正した。
- destructive annotation付きMCPを`approval_policy=never`で黙ってcancelしていた実Codex preflightを受け、全arm共通の`workspace-write`・network offを維持したまま、公式の非対話経路である`on-request`＋`approvals_reviewer=auto_review`をrun isolationへ固定した。dangerous bypassは使わない。
- provider model evidence v3はSSEの`response.created` / `response.completed`をresponse IDで一対一照合し、providerが実際に返した順序なしmodel集合だけを保持する。SSEだけではmain/reviewerの役割相関を証明できないため、requested値をactual roleへ写さない。attempt resultにも実測model集合をexact bindingし、runnerとaggregatorがmanifestの凍結集合およびSSE bytesと再照合する。usageはstdoutのmain turnだけでなく、全completed responseをmodel別に集計してから合算するため、reviewer tokenも主KPIの分子へ含む。欠損usage、重複ID、不完全pair、model差異は0補完せずrun invalidにする。
- mid-response timeoutはprovider model parserやobserverの例外でharness全体を失わず、stdoutと不完全SSEをexact bytesで保存した`timedOut` attemptとして返す。usage/model集合を推測せずnullにし、54 attempt結果をinvalidとして閉じる。公開representative-result schemaも`providerSSE`、`providerModels`、現行usage形式とnull失敗表現へ同期した。
- modelの探索callとtyped errorは隠さず全件をwire evidenceとmetricsへ残す。凍結requestと異なる探索をharness failureへせず、task別closed互換規則に合うcallだけをadapter候補にする。tool非採用や互換外requestはvalidなunsolved attemptとして外部oracleへ渡し、candidate adapter traceの欠如だけではrun invalidにしない。
- candidate observerは最後のcallでtelemetryを上書きせず、timed phase中の全callの`processesStarted`と`falseFresh`を合算する。agent reportはfunctional必須keyの欠落を拒否する一方、追加の自己申告値はcorrectness根拠へ昇格させず保持する。raw production v2 resultだけをcapability evidenceへ渡し、v1 projectionはadapter traceへ分離する。
- read-only反証のenvironment closure、npm shell迂回、NUL fail-late、profile environment失効を修正し、最終再監査で確実なP0–P2残存なし

fake process/MCPを使うself-testは実model成功を主張しない。

## actual single-attempt preflight

provider evidence v3修正後、candidateの`freshness-cache-repeat-check`を実Codexで5回preflightし、各失敗成果物を別directoryへ保持した。順に、typed MCP errorの過剰拒否、`prefer`だけを許す過剰exact制約、agent assertionsの過剰exact制約、task failureとharness failureの混同を発見・修正した。

最終preflightはharness exit 0でattempt recordを閉じた。実測はmain `gpt-5.6-sol` 23 response、auto-reviewer `gpt-5.4` 4 response、provider-reported total model token 1,073,598、wall 162,282ms。ただしexternal oracleは`secondExecutionCount=1`と凍結required outcome欠落により`solved=false`と判定した。これは期待どおり失敗試行を成功へ偽装せず、token分子へ残せた証拠であり、candidate correctness成功の主張ではない。

current `0.3.3` armの実Codex preflightもharness exit 0でattempt recordを閉じた。実測はmain `gpt-5.6-sol` 19 response、auto-reviewer `gpt-5.4` 3 response、provider-reported total model token 840,561、wall 129,053ms。旧版armは同じcheckを2回実行しており、機能評価ではunsolved候補のまま保持する。observerは旧development profileの暗黙actionをclosed mappingで正規化し、auto-reviewerがMCP transport前に拒否したcallはhost JSONLのexact errorを失敗callとして保持する。wire到達callは引き続き全件をhost eventと一対一照合し、成功callの欠落や未知tool形はfail closedする。

## 解消したpreflight blocker

1. Codex CLI 0.144.6のstdout JSONLにはactual provider modelがなかったが、provider WebSocket受信frameにactual `response.model`とusageが存在することを実測し、`response.created/completed`だけをbyte抽出した専用provider SSE JSONLへのbinding付きparserを追加した。requested `gpt-5.6-sol`は引き続き代用しない。
2. Codex JSONLはMCP resultをhost objectへ変換するが、透過stdio tapでAIShellのoriginal JSON-RPC bytesを保持できることを実Codex＋実AIShellで確認した。canonical再serializationは使わない。
3. 実probeでharnessの`runtime.json.updatedAt`が不正形式だったことも発見し、固定ISO 8601値へ修正した。
4. `aishell.package-profile.v1`を製品契約として追加し、direct Node argv、closed relevant inputs、environment key集合、`project_root_closed` effectをpackage manifestから明示できるようにした。通常npm scriptは引き続きcache ineligibleであり、`npm` executable、未知field、root escape、NUL、不正environment keyをmanifest parse時に拒否する。
5. freshness/focused fixtureへproduction manifestを追加し、fixture catalog SHAを正式改訂した。oracle、task、scenario mutation、prompt、execution contractは変えていない。合成catalog/checkは使わない。
6. production wireでは`lookupEvidence.ineligibilityReason`がnil時にfield自体を省略するため、harness validatorを現行Codable wireへ合わせた。値の意味検証は維持する。
7. 54試行の初回起動は、旧版`0.3.3`のcatalog response digestを準備時に`9b539d…`と誤記していたため、第三attemptの実model起動前にfail closedした。凍結binary SHAは一致し、同じ凍結requestを実binaryへ2回再送したraw response SHA-256はいずれも`0491fd1024fc3a34b871c6d3cf1aabff6fce4ed2539d974f3a604d4c4ee45361`だった。検証対象や方式は緩和せず、manifestをこの再現値へ訂正した。
8. 訂正後の54試行は第三attemptの旧版arm observerで、`workspace_snapshot` requestに`action` / `operation`が無いことを未対応として停止した。旧development profileの5 toolだけをclosed mappingへ固定し、未知toolを推測しないaction adapterへ修正した。
9. 修正確認preflightではauto-reviewerがtask条件に従い`run_check`をtransport前拒否し、host event 5件・wire call 4件となった。wire件数一致を緩めず、wire到達4件を順序付きでhost成功eventへ全件照合し、追加のhost失敗eventだけをexact error付き`aishell.host-rejection.v1`へ正規化する契約へ修正した。
10. 再走は8 attempt完了後、native armがCodex標準MCPの`list_mcp_resources` / `list_mcp_resource_templates`を探索した際、全MCP eventをAIShell専用shapeと誤認して停止した。server identityを保持し、AIShell callだけにclosed action mappingを適用、外部MCP callはtool名を観測actionとして記録する契約へ修正した。native seq9の実model preflightはharness exit 0、main 15 response、reviewer 1 response、provider-reported total model token 516,415、wall 87,395msで完走した。外部MCP探索はAIShell capability evidenceへ混入させず、tool call/token会計からも削除しない。
11. 外部MCP修正後の再走は20 attempt完了後、candidateのstatic-import setupで停止した。製品のevidence locatorはsource上の引用符込み文字列リテラルを正確に指すが、harness validatorとfake MCPだけが引用符なし範囲を要求していた。validatorを単一引用符または二重引用符込みのexact source一致へ直し、fake証拠も製品契約へ同期した。focused self-testと同じseq21の実candidate preflightはいずれもexit 0。実preflightはprovider-reported total model token 428,890、wall 71,343msで完走した。

## 最終production受入

- run: `benchmarks/results/phase3-production-20260723-restart-v10`
- 54/54 attempt完了、provider usage 54/54、harness stderr 0 bytes、result `valid`
- provider-reported model token: native 8,504,497、current 3,124,692、candidate 9,966,710
- solved task: native 2/6、current 2/6、candidate 6/6
- candidate: 18/18 attempt成功、tokens per solved attempt 553,706.11、tool adoption 18/18
- regression: native→current 0、native→candidate 0、current→candidate 0
- candidate product evidence: repeat cache hit 3、input change再実行3、直接/未解決impact各3/3、focused recommend/explicit-run各3/3

初回aggregationはfocused recommend-onlyの`executedChecks=0`をagent reportには保持した一方、process supervisor証拠へ転記せず、raw `change_impact` resultにも同名fieldを誤要求してcandidate 3件をfalse negativeにした。raw provider/model/MCP証拠は変更せず、観測した`processesStarted`を`executedChecks`へ投影し、tool-result照合を`structured_result`所有fieldへ限定した。修正後の18 candidate raw evidence再投影は18/18成功。元の`harness-outcome.json`、再投影`ace035-restart-v10-candidate-reprojection.json`、最終`acceptance-report-observer-fixed.json`を別々に保持し、失敗判定を上書きしていない。
