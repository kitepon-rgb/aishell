# ADR 0021: artifact query・history compare最終契約

- Status: Accepted
- Date: 2026-07-22
- Lattice task: `ACE-042`
- Control: `aishell-capability-expansion-20260721`

## Decision

`artifact_read.v2`は単一artifactのv1 readを維持しつつ、複数artifact/runをpattern、diagnostic、diffで検索・比較する。
queryはterminal immutable artifactだけを読み、managed process lifecycle、live spool、workspace状態を変更しない。

### Source boundary

run sourceはADR 0014のterminal run indexを使い、project binding一致を必須にする。direct artifact sourceも同じartifact storeと
projectへ束縛されたbearerでなければならない。artifact metadataへ`project_id`と`store_identity_digest`を持たせ、別project/storeの
handleは`ARTIFACT_SCOPE_MISMATCH`で拒否する。projectなしのlegacy artifactはv1単一readだけに限定し、v2横断queryへ暗黙昇格しない。

active、`recovery_required`、`finalizing` runは`RUN_NOT_FINALIZED`で拒否し、waitやlive spool readへfallbackしない。query開始時に
全source handle、expiry、project/store binding、content SHAをall-or-noneでpinする。一件でも不正ならresult streamを公開しない。

### Query semantics

- literal: textはUTF-8 scalar境界でcase sensitive/Unicode case foldを選べる。binary/non-UTF-8はraw byte sensitiveだけを許し、
  insensitive指定は`BINARY_CASE_MODE_UNSUPPORTED`で拒否する。
- regex: UTF-8 textだけを対象にし、engine/version、flags、step/time budgetを結果へ記録する。
- diagnostic: adapterが発行したimmutable diagnostic fieldをexact照合する。
- diff/history: source runのrequest/toolchain/input bindingを比較し、欠損bindingを同一扱いしない。

source順、stream順、byte offset、item kind、stable tie-breakをcanonicalにし、fuzzy matchをexactへ昇格しない。

### Result stream、quota、pagination

queryは完全結果をimmutable result streamとして生成し、通常responseはbounded pageとstream handleだけを返す。開始前にsource pin、
request上限、最大item数、最大stream bytesのreservationを一transactionで取得する。生成中のreservation超過は
`ARTIFACT_QUERY_QUOTA_EXCEEDED`で未公開extentを回収し、部分stream/handleを公開しない。全extent fsync後にmanifest/indexを原子的に
publishする。crash時は未公開transactionを識別して回収し、完成streamへ推測昇格しない。

各itemは1MiB page上限以下の最大encoded sizeを持つ。巨大一行、diagnostic、diff hunkはitem内部をsilent truncationせず、
`oversize_descriptor`としてsource ID、offset、full byte count、content SHA、専用artifact rangeを返し、そのitemを消費してcursorを
必ず次へ進める。0 item + 同一cursorを返してはならない。pageはitem境界だけで切り、`has_more`なら次cursorを必須にする。
cursorはstream identity、request digest、next item ordinalへ束縛し、改ざん・別stream・expiryをtyped errorにする。

### Compatibility and errors

v1単一artifact readの未知/失効handleは既存`ARTIFACT_NOT_FOUND`を維持する。v2のquery/result-stream actionも、同じartifact handleの
未知/失効には`ARTIFACT_NOT_FOUND`を使い、一般化した`HANDLE_NOT_FOUND`へ名前を変えない。result stream固有の未知handleだけを
`RESULT_STREAM_NOT_FOUND`とする。v1 `range | tail | around`、budget、SHA、expiry、完全bytesを削除しない。

## Ownership seam

- ACE-044b: query compiler/engine、immutable result stream、pagination、protocol fixtureを所有する。
- ACE-044: production run index、EvidenceStore、project/store binding、MCP統合を所有する。
- ACE-044a/ADR 0014: managed lifecycleとterminal publicationを所有する。

production manifestは少なくともproject、resolved executable、ordered arguments、cwd、environment/toolchain/input binding、terminal
artifact indexを保持し、run IDからterminal recordを取得するseamを公開する。fixture-only greenをproduction統合完了としない。

## Verification contract

- 巨大一行/diagnostic/diff hunkでoversize descriptorを返し、全page cursorが単調前進して最終到達する。
- binary sensitiveはraw offset/SHA一致、binary insensitiveとregexはexact typed rejectionにする。
- reservation不足、生成途中超過、extent/index fsync failure、crash recoveryで部分handle公開0件・未公開extent残留0件を確認する。
- direct artifactの別project/store、legacy unbound artifactをv2 queryで拒否する。
- v1/v2 artifact handle errorは`ARTIFACT_NOT_FOUND`、stream handleだけ`RESULT_STREAM_NOT_FOUND`に固定する。
- active runを`RUN_NOT_FINALIZED`にし、terminal runのindex/binding/artifact SHAを一致させる。
- search page連結が完全result streamとbyte/item単位で一致し、重複、欠落、silent truncationがない。
- v1 single readの3 mode、budget、SHA、expiry、完全artifactを非回帰にする。

## Consequences

EvidenceStoreは完成済み`Data`一括保存だけでなく、reservation付き未公開extentと原子的stream publicationを扱う必要がある。
direct artifact metadataへproject/store bindingを追加するが、legacy v1 readを削除しない。query都合でprocessを待機・停止したり、
別projectの工程証拠を返したりしない。
