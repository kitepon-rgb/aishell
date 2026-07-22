# ADR 0025: Phase 5受入

- Status: accepted
- Date: 2026-07-23
- Lattice plan: `aishell-capability-expansion`
- Lattice phase: `phase-5`

## Decision

Phase 5「transactional apply」を受け入れる。expected SHA付きmulti-file transaction、事前競合検出、all-or-nothing適用、
result diff、更新後cursorを公開wire 9 tests、failure 0で確認した。

host `apply_patch`比較ではcorrectnessと確認roundtrip削減を受け入れ、provider tokenを採取していないためtoken削減率、
隔離反復でないwall改善は主張しない。競合時に部分適用やsilent retryは行わない。

## Evidence

- `docs/evidence/2026-07-23-ace-053-phase5-acceptance.md`
- `docs/adr/0017-apply-change-set-contract.md`

## Consequences

Phase 5のatomic edit契約を閉じる。default昇格とreleaseはPhase 6/7のdiscovery・product gate後だけ許す。
