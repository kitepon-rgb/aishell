# ADR 0013: focused check候補と明示実行の分離契約

- Status: superseded by ADR 0020
- Date: 2026-07-21
- Lattice task: `ACE-033`
- Control: `aishell-capability-expansion-20260721`

> このADRは翌日の[ADR 0020: focused check候補・set最終契約](0020-focused-check-final-contract.md)に
> 置き換えられた。ACE-033の完了証拠もADR 0020である。実装契約としては参照しないこと。
> 主な相違: 本ADRは`change_impact`の成功resultを`aishell.change-impact.v1`とし、`focusedChecks`と
> `focusedCheckSet`を候補descriptor込みで返す形だった。ADR 0020はschemaを`aishell.change-impact.v2`の
> `operation: recommend`に置き換え、top-levelを`focusedSetID`／`focusedSetDigest`／`coverage`／
> `candidateCount`等のclosed setへ絞り、実行はcallerがADR 0018の`invocation.mode: focused_set`を
> 明示した`run_check`でだけ成立させる。以下は当時の検討記録として残す。

## Context

`change_impact`は変更path／symbolから関連testやbuild targetを絞り、`run_check`はその結果を使って再実行を
減らす必要がある。一方、候補生成とprocess実行を一回の暗黙動作へまとめると、推定が外れた時に何を実行したか、
何を実行しなかったか、なぜ全testへ広がったかをcallerが判定できない。これはcorrectnessを最優先する本製品で
許容できない。focused化は実行範囲を狭める権限ではなく、根拠付きの選択肢を提示して明示選択を一回のpipelineへ
変換する機能だけとする。

## Decision

### 1. 候補生成と実行を別トランザクションにする

`change_impact`はread-onlyな候補生成だけを行い、processを起動しない。成功result
`aishell.change-impact.v1`へ`focusedChecks`と`focusedCheckSet`を返す。`focusedCheckSet`はopaqueな
`setID`、project/root identity、workspace cursor、project profile digest、impact evidence digest、生成時刻、
expiryを持つ。候補集合が空でも成功であり、その場合も完全性と未解決理由を返す。

各`FocusedCheckCandidate`は少なくとも次を持つ。

- content-addressedな`checkID`、人が読める`label`、`kind`（`build | test | lint | custom`）
- manifest由来の実行descriptor（executable、順序付きarguments、cwd、environment binding、target／test selector）
- その候補がcoverするchanged path／symbol／targetと、coverできない入力
- `reasons`、`confidence`、`provenance`、`freshness`
- 一候補の内部step DAGと、各stepが必須か否か。候補の選択はその公開済みstep DAG全体への同意を意味する

`checkID`はcanonical execution descriptor、project identity、profile digestから導出し、表示順や生成時刻では変えない。
同じdescriptorを複数のimpact理由が推薦しても一候補へdeduplicateし、全理由を保持する。候補順は
`confidence desc → kind → label → checkID`で決定的にする。

`completeness`は`complete | partial | unknown`のclosed setとし、`partial`／`unknown`では
`uncoveredInputs`と`limitations`を必須にする。完全性を証明できない時に`complete`を返してはならない。

### 2. manifest、impact evidence、provenance

候補の実行descriptorはproject profileが保持するmanifest、toolchain、target、既知のbuild/test/lint入口だけから作る。
arbitraryなshell文字列を生成せず、executable URL、arguments、cwd、environmentを分離したまま保持する。SwiftPMの
test target／test selector、npm scriptなどecosystem固有のselectorはproviderが正規化し、元manifest path、file identity、
content SHA、profile digestをprovenanceへ残す。

impact evidenceは候補を生成したchanged path／symbol、reference、dependency edge、related test、build targetの
evidence IDを参照し、provider名、provider version、観測cursor、source digest、`authoritative | derived | heuristic`を
各edgeに付ける。manifestに存在しないcommandを慣例名だけで捏造しない。heuristic evidenceは候補を提示できるが、
その由来と限界を隠さず、完全性判定のauthoritative根拠には使わない。

profile unavailable、unsupported ecosystem、impact stale、target mapping ambiguityはtyped limitationまたはtyped errorにし、
`swift test`、`npm test`、repository全体test等を暗黙候補や暗黙実行へ差し込まない。callerが全体checkを望む場合も、
manifest由来の全体check候補IDを明示選択する。

### 3. `run_check`はcallerが選んだIDだけを実行する

`run_check` v2のfocused pipeline requestは`focused_check_set_id`と非空の`check_ids`を必須にする。
`check_ids`はcallerが明示した候補IDの集合であり、AIShellは選ばれていない候補を追加しない。選ばれた一候補に
公開済みの内部step DAGがある場合だけ、そのstepをmanifest順序制約に従って実行する。未知ID、重複ID、空選択、
別候補集合のIDは、それぞれ機械判定可能なrequest errorとしてprocess起動前に停止する。

実行前にproject/root identity、workspace cursor、profile digest、impact evidence digest、各manifest file identity/hashを
再照合する。差異は`CHECK_SELECTION_STALE`、expiryは`CHECK_SET_EXPIRED`、provenance欠損／破損は
`CHECK_PROVENANCE_INVALID`とし、候補再生成、直接command、全testへfallbackしない。callerが新しい
`change_impact`を呼び直して選び直すことを`next_action`に示す。

focused pipelineのplanはprocess起動前に確定し、`requestedCheckIDs`、`plannedCheckIDs`、順序付きstep、
selection digestをresult evidenceへ残す。`requestedCheckIDs`と`plannedCheckIDs`は同じ集合でなければならない。
各terminal resultはstepごとの`executed | cache_hit | skipped_dependency_failure | cancelled`、run/artifact handle、
diagnostic、開始時のfreshness bindingを返す。freshness cacheの採否はACE-030契約、非同期run handleはACE-040契約に
従うが、cache hitや非同期化を理由に選択範囲を変えない。

既存`run_check` v1のdirect executable/arguments/cwd/env入力は同期互換actionとして維持する。direct actionとfocused
pipeline actionはone-ofであり、同一requestへ混在させない。互換actionをfocused candidateの不足を埋める内部fallbackに
使わない。

### 4. failureと可観測性

候補生成のprovider failure、manifest parse failure、impact evidence失効は省略して成功扱いにせず、候補ごとまたは
request全体のtyped状態として返す。`change_impact` resultには`candidateCount`、`completeness`、`uncoveredCount`、
provider別状態を常に含める。`run_check` resultには選択数、実行数、cache hit数、未実行理由を常に含める。

pipeline stepの失敗後は、その候補descriptorで明示されたdependencyに従って後続stepをskipできるが、別候補や全testを
代替実行しない。部分実行を成功へ丸めず、どの選択IDがterminalにならなかったかを返す。artifact保持失敗、cache破損、
worker起動失敗も直接実行へ切り替えず、所有契約のtyped errorで停止する。

## Verification contract

- `change_impact`へSwiftPM manifest、changed production path、related test evidenceを与え、候補ID、selector、coverage、
  manifest SHA、impact provenance、決定的順序をfixtureと一致させる。npm scriptについても同じ境界を固定する。
- process executor spyで`change_impact`単独では起動0件であることを確認する。
- 3候補からcallerが2 IDだけを指定し、`run_check`がその2候補の公開済みstepだけを実行すること、結果の
  requested/planned集合が一致することを確認する。
- 空選択、未知／重複／別set ID、期限切れ、manifest変更、workspace cursor変更、impact evidence変更を固定し、
  process起動0件と対応typed errorを確認する。
- `partial`／`unknown`候補集合、provider unavailable、関連test 0件で、全testや慣例commandが追加・実行されないことを
  確認する。全体checkはcallerがその候補IDを選んだ場合だけ実行される。
- 最初のstep失敗、cache corruption、worker起動失敗で、依存後続以外の選択候補と全testへsilent fallbackしないこと、
  未実行理由と一次証拠が失われないことを確認する。
- direct v1 actionのexecutable/arguments/cwd/env、timeout、retention、terminal status、stdout/stderr handleを非回帰とする。

## Consequences

ACE-034はこの契約を`DevelopmentRuntimeService`へ統合し、MCP handlerにはschema変換だけを置く。候補生成は
`ChangeImpactService`側、実行plan解決はfocused pipeline側へ分離し、共通なのはcontent-addressed descriptorと
freshness bindingだけにする。

現行工程にはACE-033からACE-034への直接hard dependencyが不足している。ACE-034が本契約より先に統合へ進めないよう、
次revision transactionで`ACE-033 → ACE-034`を明示し、既存joinと矛盾しないことをcompile/verifyする。

公開toolは増やさず、`change_impact`と`run_check`の責務境界を使う。default 9／full 29 tool、既存20 primitive、
`run_check` v1互換actionを削減しない。
