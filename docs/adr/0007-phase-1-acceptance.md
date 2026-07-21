# ADR 0007: Phase 1受入

- Status: accepted
- Date: 2026-07-21
- Control: `aishell-capability-expansion-20260721`
- Lattice plan: `aishell-capability-expansion`
- Lattice phase: `phase-1`

## Decision

Phase 1「永続workspace state」を受け入れる。

root identity、FSEvents volume UUID、per-device event stream、処理済みwatermark、generation、entry metadata/hashを束縛した
永続checkpointを採用する。warm restartはcheckpoint entryを現在filesystemへ照合し、変更候補だけを再読する。gap、drop、wrap、
root change、UUID不一致、null watermark、corrupt payload、quota、atomic commit失敗はtyped error又はcallerが要求した明示full
rebuildへ分離し、silent fallback、silent truncation、stale resultのfresh偽装を許さない。

効率化は再起動時の重複content readと重複scanを削るが、既存5 development tool、2 recovery control、full profile 25 tool、
legacy 20 primitive、S〜B能力、後続Phaseの受入条件を削減しない。

## Evidence

- `docs/adr/0006-persistent-workspace-checkpoint-contract.md`
- `docs/evidence/aishell-phase-1-gate-20260721.md`
- `rag/fsevents-persistent-checkpoint-continuity.md`
- `rag/fsevents-device-boundary-observation.md`

120 file fixtureのproduction相当per-device FSEvents経路で、cold 120 content readに対しwarm 0 read、offline
modify/rename/delete oracle一致を確認した。wall単発値は隔離反復でないため速度改善の主張には使わない。

独立反証は複数回のrejectを経て、callback/actor race、root path drop、null watermark、eviction rollback、full rebuild prefetch、
volume UUID、per-device stream、firmlink pathを修正へ還流した。device timestamp検索値を直後rollback判定に使う提案は、Apple SDK
契約と6秒超の遅延実測、120→480 readへの悪化に基づき監査役自身が撤回し、最終判定はblocker 0、feature shrinkなしとなった。

## Consequences

Phase 2以降のGit diff context、project profile、search context、run cache、impact、async process、artifact query、workspace wait、
transactional applyを開始できる。expanded surfaceのdefault昇格、288 attempt実測、30% token削減product gate、公開releaseは
未達であり、後続Phaseの完了条件を縮小しない。
