# ADR 0022: Phase 2受入

- Status: accepted
- Date: 2026-07-23
- Lattice plan: `aishell-capability-expansion`
- Lattice phase: `phase-2`

## Decision

Phase 2「高頻度context統合」を受け入れる。Git diff context、project profile、search/read context、continuation、
永続checkpointを公開契約どおり統合し、full gate 502件はfailure 0だった。

gate初回で検出した再起動後のretained change消失は、checkpointへsequence結合済み`journal_changes`を保存・復元する
修正へ還流した。diff/search recall、continuation integrity、model-visible budget、native複数call比較を満たし、
silent fallbackはない。wall/token削減は隔離provider比較でないため主張しない。

## Evidence

- `docs/evidence/2026-07-23-ace-024-phase2-acceptance.md`
- `docs/adr/0008-git-diff-context-contract.md`
- `docs/adr/0009-project-profile-contract.md`
- `docs/adr/0010-search-context-v2-contract.md`

## Consequences

Phase 2の正確性・full regression・maintenance修正は閉じる。Phase 3以降の受入条件は縮小しない。
