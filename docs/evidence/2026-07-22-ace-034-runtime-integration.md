# ACE-034 公開runtime統合証拠

- 日付: 2026-07-22
- Lattice task: `ACE-034`
- Control: `aishell-capability-expansion-20260721`
- Control task: `ace034-public-runtime-wire-integration`
- Control finalization revision: `127`
- 実装commit範囲: `e98c11a..adc39bc`

## 受入結果

- `run_check` v2のdirect、profile、focusedを`DevelopmentRuntimeService`へ統合した。
- `ProjectProfileService`、`FocusedCheckService`、`ChangeImpactService`を同一runtimeで共有し、caller supplied catalog、再観測closure、selection hashの捏造を公開入力から除いた。
- `change_impact`のanalyze、recommend、continuationを同じservice authorityへ結線した。continuationはexact membershipが一意な場合だけ消費する。
- focused wireは`prepare_focused_set`と`verify_focused_set`を加算的に提供し、recommendationからprepare、返却selection digestによるverify再実行まで成功した。
- profile、cursor、manifest、focused setのdriftは`RUN_CHECK_SELECTION_STALE`、process 0で返る。複数owner rootでも対象rootだけを一意に再観測する。
- direct + non-off cache、非ASCII SHA、schema上限超過、binding field混在をschema/runtime双方で拒否する。
- legacy v1のflat direct入力、fractional timeout/retention、v1結果shapeは維持した。
- `start`はACE-044のmanaged lifecycle実装まで`RUN_CHECK_START_NOT_READY`、process 0で停止する。同期実行へのfallbackはない。

## 検証

次のfocused/related suiteを同一candidateで実行し、すべて成功した。

- `swift test --filter MCPRunCheckV2WireTests`
- `swift test --filter MCPRunCheckAdapterTests`
- `swift test --filter MCPRunCheckV2SchemaTests`
- `swift test --filter RunCheckPipelineIntegrationTests`
- `swift test --filter DevelopmentRuntimeServiceTests`
- `swift test --filter ChangeImpactServiceTests`
- `swift test --filter ContextCompilerServiceTests`
- `swift test --filter ProjectProfileServiceTests`
- `swift test --filter RunCheckResolutionServiceTests`
- `git diff --check`

複数owner rootの独立反証で、focused receiptのcursorを別rootへ適用するP1を再現した。
`ProjectProfileService`がproject IDまたはprofile digestのcache索引から候補rootを一意に絞る修正と、
兄弟rootを二つ登録した公開wire回帰を`adc39bc`へ追加し、再試験を成功させた。

## Silent fallback確認

- cache corruptionをmissやuncached実行へ変換しない。
- focused selectionを全testへ拡張しない。
- stale profile/cursorをgeneric successへ丸めない。
- `start`をsyncへ変換しない。
- continuation registryをtoken prefixで推測しない。
- relevant-input再観測失敗時はcache publicationを拒否する。

## 継続範囲

非同期`start`、run handle、observe/cancelはACE-040〜044の所有範囲であり、ACE-034では未実装を
明示的なtyped not-readyとして維持する。Phase 3の効果測定と受入は後続ACE-035で行う。
