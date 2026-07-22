# AIShell representative suite freeze

ACE-002で、実装前の比較契約を次のファイルへ固定した。

- suite: `benchmarks/representative-suite.v1.json`
- suite SHA-256: `201958f03dc3b85ea6bfe9cca3b5edfec88124da8a790539639465fab8f46cf7`
- capability fixtures: `benchmarks/capability-fixtures.v1.json`
- fixture catalog SHA-256: `630680d817d8fbc767072efde5844027534c0de4536fa301ecd0e9165637d5b9`
- task goals: `benchmarks/representative-task-goals.v1.json`
- task goals SHA-256: `810103d0f1358685db035f6f1f711895f411c21e15ba0f8b9de1c3a6761d8e5d`
- execution contracts: `benchmarks/representative-execution-contracts.v1.json`
- execution contracts SHA-256: `aa02c3d604dbad28c182ff9ae1df836b7781d671b199a48f3df3e7a4fe3f6163`
- generated seed materializer SHA-256: `34c2b97adc82555febd984b13cc7f6987184bca76b2488a9e68c052f00762ef0`
- oracle evaluator: `benchmarks/evaluate-capability-oracle.mjs`
- oracle evaluator SHA-256: `8e79055172dc753427c21ece635cfa5a4932e72afce5026f35a6e6ce6c988b88`
- workspace manifest capture: `benchmarks/capture-workspace-manifest.mjs`
- external observer: `benchmarks/observe-capability-attempt.mjs`
- external observer SHA-256: `a9dd9f520b429f8d40746e8134ca3ed1c2e9933075baa7a702e7c87f3ad1fcbd`
- observation schema: `benchmarks/capability-attempt-observation.v1.schema.json`
- observation schema SHA-256: `ae65fb56b21282df41f6b07fdb96a9dc07fbda8cfbf43e8303540949bd2a71d8`
- deterministic request materializer: `benchmarks/materialize-capability-request.mjs`
- request materializer SHA-256: `0d9ebb7d1a5c565ec6476ef723dc5a0e96589a35291227d24cbd3d521747b4a3`
- request contract schema SHA-256: `b300beeb230fc0248fdb3f2e6adebaad42a5a212bc670658aedd3b5c915a75a9`
- setup evidence schema SHA-256: `c3707cd9e451c1d676c8a4b96212c4b50bdf0c92a487661df189c41b66555317`
- discovery probes SHA-256: `bf1c225e163599e4d9c088dc948a535401ea64fe89c34490a11851a17c1b8678`
- discovery prompt renderer SHA-256: `6e1240aa4a287714d158e39cf29eb2e2c07008b7654ddbdab2143e2eb3014f2f`
- discovery evaluator SHA-256: `de840e0be0cd0d9b66abadf53698b80410a42560de64daa9939558a0bb0869ab`
- validator: `node benchmarks/validate-representative-suite.mjs`
- evaluator self-test: `node benchmarks/test-capability-oracle.mjs`
- observer negative self-test: `node benchmarks/test-capability-observer.mjs`
- request materializer self-test: `node benchmarks/test-capability-request-materializer.mjs`
- discovery evaluator self-test: `node benchmarks/test-tool-discovery-evaluator.mjs`

16 capability fixtureに各2 scenario、合計32 taskを登録した。armはnative、現行AIShell 0.3.3、
拡張candidateの3本で、各task 3反復、計288 attemptを事前登録する。arm順だけをrandomizeし、model snapshot、
reasoning、prompt、fixture bytes、sandboxは揃える。

各taskはmodel-visible goalとparameter、harness-only setup/timed step、oracle、observer sourceを分離する。
modelへoracleを渡さず、observer自身がworkspace manifest、process record、artifact record、structured result、
AIShell telemetryを読み、凍結oracleとsource contractをevaluatorが照合する。callerがproducer/source名を
自己申告する`--actual`入口は公開しない。nativeと0.3.3 armでは後発AIShell内部telemetryだけをnot-applicableとし、
機能assertionは3 armすべてに適用する。internal telemetry比較は両armが実測したkeyだけで行い、欠落を0にしない。
candidateはtask別に凍結したexpanded AIShell toolをraw tool traceで使用した場合だけ成功できる。artifactはworkspace seedでなく
retained storeのmanifest、handle、SHA-256、実bytesを読む。変更系baseline欠落はharness failure、continuationの完全集合は
workspace実bytesまたはbaseline/current差分から独立算出する。actualは公開JSON Schemaをruntimeでも検証する。
requestはfield名やnonemptyだけでなく、fixture、pre-attempt manifest、baseline manifest、harness setup evidenceから
32 taskすべてを決定的に再生成し、observerが外部request contractとraw traceをexact照合する。artifact handleはretained store、
非同期run IDはrun結果へ結合する。discoveryはcandidate専用gateであり、model-visible入力からprobe IDと期待toolを除外し、
positiveは期待toolちょうど1回、no-call controlは0回だけを成功とする。

armごとの完全tool catalog、300秒timeout、paired randomization seed、invalid attempt非置換、task solvedを3反復
全成功とする規則を固定した。集計はoverall-armとper-task-armの両方で行い、失敗attemptのtokenも分子へ含める。
1000 fileの永続workspace、2000 file・約8 MiBのcontext tree、10秒processを含み、microfixtureだけに限定しない。

主KPIは全attemptのprovider報告total model token合計をoracle成功数で割る。usage欠落は0へ丸めずrun invalid、
成功0は正の無限大とする。candidateはnative成功taskと現行0.3.3成功taskを一件も落としてはならない。
fixture oracleは成功だけでなく、silent fallback、false-fresh、partial write、orphan process、stale semanticなど
能力固有の禁止結果も固定する。

このfreezeは比較設計の受入であり、288 attemptの実行結果やproduct gate成功は主張しない。

## Phase 3 production profile amendment（2026-07-22）

ACE-035のproduction preflightで、freshness-cache fixtureにはProjectProfileServiceが解釈できるmanifestがなく、
focused-pipeline fixtureにもproject profile境界がなかったことを実測した。合成profileをharnessへ注入せず、製品側の
正式な`aishell.package-profile.v1` contractを採用したため、次の範囲だけfixture catalogを改訂した。

- freshness-cache: `package.json`へdirect `node check.mjs`、空のclosed environment集合、exact input 2件、`project_root_closed`を明示
- focused-pipeline: `package.json`へnpm project境界と既存test scriptを明示
- task ID、scenario mutation、oracle、model-visible goal、execution contract、suite順序は不変
- fixture catalog SHA-256: `def2454c3e56917812c0cb07c67523a4b90d15c1f24f4834c5ff6fa189b03982`

旧SHA `630680d817d8fbc767072efde5844027534c0de4536fa301ecd0e9165637d5b9`およびpreflight中間SHA
`6740caa417ad898736d55cc1d4744986bb986f945ead7e09231366b53fe0f8f9`を新bytesへ流用しない。
Phase 3 manifestは新SHAへexact bindし、旧fixture catalogで得たattemptと混在させない。
