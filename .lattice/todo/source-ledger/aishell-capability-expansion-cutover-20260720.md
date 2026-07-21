# Lattice ToDo archive
Plan: aishell-capability-expansion
Batch: initial-cutover-20260720
Revision: a8fdf2365f7f3568dba93f60458c766bb0a8e3330de1e8bf7d4edd0cff1c39e6

- [ ] ACE-001 現行0.3.3の同期状態、42 test green、M1証拠を固定し、Controlをinitしてrisk・behavior laneを記録する。
- [ ] ACE-002 30件以上の代表suite、各機能のcapability fixture、current-AIShell比較arm、oracle、集計式を実装前に凍結する。
- [ ] ACE-003 default 9 toolの名称、責務、schema version、互換期間、feature flag、tool discovery日英probeをF裁定する。
- [ ] ACE-004 root/generation/exclusion/cursor、file identity、rename/delete、event gap、retentionの未完契約とcharacterization testを閉じる。
- [ ] ACE-010 永続checkpointのroot identity、entry metadata/hash、FSEvents event ID、generation、schema migration、quota契約をF裁定する。
- [ ] ACE-011 cold start、warm restore、offline変更、event gap、root置換、corrupt checkpointをfail closedで固定する安全網を先行実装する。
- [ ] ACE-012 RuntimeStore配下へpersistent workspace indexとobservation journal checkpointを実装し、OS現在状態との照合を正本にする。
- [ ] ACE-013 warm restart microbenchで全量content再読を削減し、delta/rename/delete oracleと既存suite非回帰を確認してPhase 1を受け入れる。
- [ ] ACE-020 staged/unstaged/untracked/base差分、rename、budget、continuation、SHAを持つGit diff context契約をF裁定する。
- [ ] ACE-021 manifest、toolchain、target、既知のbuild/test/lint入口を保持し変更時だけ失効するproject profile契約をF裁定する。
- [ ] ACE-022 複数query、regex、glob、case、前後行、共有budget、dedup、変更/test優先を持つsearch_context v2契約をF裁定する。
- [ ] ACE-023 workspace_snapshot、search_context、read_contextへGit diff、project profile、一括検索・range読取を実装する。
- [ ] ACE-024 diff recall、search recall、continuation integrity、model-visible budget、native複数call比較を検証してPhase 2を受け入れる。
- [ ] ACE-030 executable、arguments、cwd、environment、toolchain、relevant input hashを束縛するrun_check freshness cache契約をF裁定する。
- [ ] ACE-031 false-fresh 0件、変更理由付き失効、cache corruption、TTL/quota、success/failure再利用を固定する安全網を先行実装する。
- [ ] ACE-032 changed path/symbolからreference、dependency、related test、build target、根拠、freshnessを返すchange_impact契約をF裁定する。
- [ ] ACE-033 manifestとimpact evidenceからfocused check候補を返し、呼出側指定時だけpipeline実行する契約をF裁定する。
- [ ] ACE-034 freshness cache、change_impact、focused pipelineを実装し、silent test selectionとsilent cache fallbackを禁止する。
- [ ] ACE-035 repeated-check、multi-file change、stale-after-edit fixtureで再実行・tool call・tokenを比較しPhase 3を受け入れる。
- [ ] ACE-040 run handle、status、wait、incremental evidence、terminal state、retentionを持つ非同期process契約をF裁定する。
- [ ] ACE-041 cancel/timeout race、PID reuse、descendant process、server restart、artifact完全性を固定する安全網を先行実装する。
- [ ] ACE-042 複数stdout/stderr/runをpattern・diagnostic・差分で横断するartifact query/history compare契約をF裁定する。
- [ ] ACE-043 cursor以後のOS変更をtimeout/cancel可能に待つworkspace_wait契約とFSEvents gap時の明示errorをF裁定する。
- [ ] ACE-044 run_observe、artifact横断検索・比較、workspace_waitを実装し、MCP request受付とjob lifecycleを分離する。
- [ ] ACE-045 long build、cancel、incremental failure、external edit fixtureでfirst useful resultとwall timeを比較しPhase 4を受け入れる。
- [ ] ACE-050 expected SHA、複数file all-or-nothing、create/delete/rename、rollback、result diff、workspace cursorを持つapply_change_set契約をF裁定する。
- [ ] ACE-051 stale SHA、途中失敗、symlink/root escape、同一file重複、crash recoveryでpartial write 0件を固定する安全網を先行実装する。
- [ ] ACE-052 apply_change_setを実装し、成功後のdeltaと影響候補を追加scanなしでworkspace runtimeへ反映する。
- [ ] ACE-053 host apply_patch比較でcorrectnessを維持し、編集・確認・再snapshot callを削減できることを確認してPhase 5を受け入れる。
- [ ] ACE-060 Xcode/xcresultを先頭に、SARIF、Cargo JSON、Bazel BEPを共通diagnostic schemaへ変換するadapterを需要順に実装する。
- [ ] ACE-061 SourceKit-LSPのdefinition/reference/symbol/diagnosticをOS file hashへ束縛しfresh/stale/indexing/unavailableを明示する。
- [ ] ACE-062 build manifest、depfile、LSPをworkerとして使うdependency/affected-test providerを実装し、heuristic provenanceを返す。
- [ ] ACE-063 workspace_snapshotへworktree/branch比較modeを追加し、root identity、base、dirty state、budget付きdiffを返す。
- [ ] ACE-064 lexical、semantic、dependency adapterのablationとstale-after-edit検証を行い、改善しない経路は利用可能でもdefault routingへ入れない。
- [ ] ACE-065 default 9/full 29 tool profile、schema、instructions、日英tool discovery、互換性を統合しPhase 6を受け入れる。
- [ ] ACE-070 native、現行0.3.3、拡張candidateを30 task以上×事前登録反復で比較し、全試行token、成功率、wall、tool adoptionを集計する。
- [ ] ACE-071 baseline成功taskを落とさずtokens per solved task 30%以上削減、p50非悪化、p95悪化10%以内、silent fallback 0をproduct gateとする。
- [ ] ACE-072 Phase maintenanceを一回だけ処理し、関連test、swift test、package-app、MCP wire fixture、最終独立監査を通す。
- [ ] ACE-073 README、MCP instructions、RAG、release notes、公開schemaを同期し、Phase Decision ADRとControl finalization証拠を残す。
