# ADR 0020: focused check候補・set最終契約

- Status: Accepted
- Date: 2026-07-22
- Lattice task: `ACE-033`
- Control: `aishell-capability-expansion-20260721`

## Decision

`change_impact operation: recommend`は候補とimmutable focused setを生成するだけで、test/build/lintを実行しない。
実行はcallerが別の`run_check`でADR 0018の`invocation.mode: focused_set`とordered non-empty check IDsを明示した時だけ
成立する。dispatch/cacheは共通planの独立軸であり、候補、selector、setから暗黙選択しない。

### Raw recommend v2

schemaは`aishell.change-impact.v2`のまま、top-levelを次のclosed setにする。

- `schema`, `operation: recommend`, `executionPolicy: explicit_run_check_only`
- `focusedSetID`, `focusedSetDigest`, `expiresAt`, `freshness`
- `coverage`, `candidateCount`, `stepCount`, `limitationCount`
- `items`, `byteBudget`, `hasMore`, `continuation`, `artifact`

未知fieldとanalyze専用fieldを混入しない。itemsはglobal deterministic orderを持つstreamで、kindを
`focused_candidate | focused_step | dependency_edge | manifest_binding | impact_evidence | coverage_gap`へ閉じる。
各itemはkind固有のexact field set、stable ID、provider/version、freshness、source artifact digestを持つ。
`focused_candidate`のselectorは少なくとも`test_path`、`profile_check`、`target`のclosed unionとし、`test_path`は
root-relative `path`を必須にする。legacy `recommendedChecks`へ投影できるのはこの`test_path`だけである。

`ProjectProfileService`がmanifest/toolchain、profile check descriptor、manifest identity/SHA、profile digestを所有する。
`test_path`の所有判定はprofile root内かついずれかのtarget `sourceRoots`内であることを使い、targetの`kind == test`を
追加条件にしない。npmの通常profileは`kind: library`のtargetが`src`と`test`を所有するためである。実行候補への昇格は、
このpath所有に加えてprofileに`kind: test`のcheck descriptorが存在する場合だけ許可する。
`ChangeImpactService`がimpact input、evidence ID、provider/version、locator、ADR 0012のevidence strength、freshness/artifact digestを
所有する。focused providerは両者をID/digestでexact joinし、confidenceを捏造せず、欠損やdigest不一致を候補省略で隠さない。

### Identity、set、selection

`profileCheckID`はADR 0009のlogical entrypoint IDである。`focusedCheckID`はprofile check ID、profile digest、selector、
step-DAG digestから別に導出する。同じdescriptorへの複数impact理由は一candidateへdedupし、全evidence edgeを保持する。

opaque `focusedSetID`とcontent-addressed `focusedSetDigest`を分ける。digestはschema、root/project identity、generation/cursor、
profile/manifest identity、impact request/result artifactまたは完全stream digest、ordered candidate ID、各DAG digest、coverageと
limitationsを束縛する。生成時刻とexpiryはidentityへ入れずadmission validityにする。全continuation pageは同じset ID/digestへ
束縛する。

`selectionDigest`はset digest、callerの重複なしordered check IDs、各DAG digestを束縛する。admission前にroot、generation/cursor、
profile、manifest、impact、set、selection、expiryを再照合する。`plannedCheckIDs`は`requestedCheckIDs`とbyte-for-byte同じordered
arrayでなければならず、cache hit/miss、sync/startで変更しない。

公開wireは二つの加算的bindingを持つ。`prepare_focused_set`はset digestとordered check IDsを受け、共有
`FocusedCheckService`でselection digestを生成して実行する。`verify_focused_set`は既に得たselection digestも受け、
同じ材料からの一致を再検証して実行する。前者は後者を置換せず、どちらもset/profile/cursor/manifestのcurrent性を
process admission前に確認する。binding間のfield混在、focused invocationへのplain `prepare`、direct/profileへの
focused bindingはclosed input違反として拒否する。

### Step DAG

step IDとdescriptor digestをcontent-addressed化し、edgeは`depends_on`だけを許す。unknown endpoint、duplicate step/edge、self edge、
cycleはadmission前に拒否する。実行順はdeterministic topological orderで、同順位は公開ordinal、なければstep IDのunsigned UTF-8
byte順とする。optional stepは設けない。callerの選択は公開済みDAG全体への同意であり、未公開step、別candidate、全testへの
拡張は禁止する。step失敗時は到達するdependentだけをskipし、独立candidateを代替・省略しない。

### Errorとprocess 0条件

- empty/unknown/duplicate/cross-set ID、invalid DAG、union/余剰field: `RUN_CHECK_INVOCATION_INVALID`
- root/generation/cursor/profile/manifest/impact/set/selection不一致またはexpiry: `RUN_CHECK_SELECTION_STALE`
- cache onlyのmiss/incomplete/expired: `RUN_CHECK_CACHE_MISS`
- cache corruption: `CACHE_CORRUPT`
- client key異digest: `RUN_KEY_CONFLICT`

structural、freshness、provenance、cache admission errorは全てprocess 0件を証拠化し、fallbackしない。focused `only`は全step hit
だけ成功し、一件でもmissなら部分成功0件である。全cache hitのstartは0-process terminal managed handleを返す。

## Verification contract

- raw recommend v2のexact key/item-kind fixtureと`executionPolicy`を固定する。
- candidate-only callのexecutor/process countを0にする。
- manifestとimpact evidenceの全provenanceを逆引きし、provider順を変えてもID、set digest、artifact SHAを一致させる。
- duplicate reasonはcandidate一件へまとめ、全evidenceを保持する。
- continuation全pageで同じset digestを維持する。
- ordered 2 ID指定でrequested/planned arrayをexact一致させる。
- empty/unknown/duplicate/cross-set/stale/profile/manifest/impact/provenance/DAG errorをexact code・process 0で固定する。
- DAG cycle/unknown endpoint/duplicate edgeとdeterministic topological orderを確認する。
- sync/start × off/prefer/only/refreshでselection/DAGを変えない。
- only部分hitは全体error・部分成功0・process 0、全hit startは0-process terminal handleとする。
- step failureでdependentだけをskipし、全test fallbackを0にする。
- 現行recommend `NOT_READY`とdirect v1をcutoverまでcharacterizationとして固定する。
- MCP closed union、`additionalProperties: false`、成功/error structured fixtureを確認する。
- recommendationから`prepare_focused_set`で同一runtime実行でき、返されたselection digestを`verify_focused_set`でも再照合できることを確認する。

## Consequences

active Lattice topologyには`ACE-033 -> ACE-034` hard dependencyが存在する。ACE-034は本契約とADR 0012/0018を実装へ統合し、
recommendの暗黙実行、全test fallback、cache/dispatch選択、候補のsilent省略を実装しない。
