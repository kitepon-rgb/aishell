# ADR 0024: Phase 4受入

- Status: accepted
- Date: 2026-07-23
- Lattice plan: `aishell-capability-expansion`
- Lattice phase: `phase-4`

## Decision

Phase 4「managed process・artifact query」を受け入れる。run start/observe/wait/cancel、incremental diagnostic、
artifact search/compare/group、workspace waitをservice-level gateへ通し、changed path一致、wall非悪化、silent fallback 0を確認した。

このfixtureではprovider modelを起動していないためtoken値を生成・推測せず、round trip削減も主張しない。
競合・timeout・cancel・retentionはtyped stateと完全artifactで閉じる。

## Evidence

- `docs/evidence/2026-07-23-ace-045-phase4-acceptance.md`
- `docs/evidence/2026-07-23-ace-045-phase4-measurement.json`
- `docs/adr/0014-managed-process-contract.md`
- `docs/adr/0015-artifact-query-contract.md`
- `docs/adr/0016-workspace-wait-contract.md`

## Consequences

Phase 4のprocess lifecycleとartifact完全性を閉じ、Phase 5以降のtransaction・semantic受入へ進める。
