# ADR 0023: Phase 3受入

- Status: accepted
- Date: 2026-07-23
- Lattice plan: `aishell-capability-expansion`
- Lattice phase: `phase-3`

## Decision

Phase 3「freshness cache・変更影響」を受け入れる。production受入網は6 task × 3 arm × 3反復の54 attemptを
54/54完走し、candidateは18/18成功、provider usageは54/54、correctness regressionは0だった。

model identity、usage、MCP wire、binary/catalog digest、external oracle、observer telemetryをattempt単位でexact bindし、
失敗試行tokenを分子から除外しない。preflightで見つかったobserver、provider evidence、legacy adapter、外部MCP識別、
fixture bindingのblockerは契約を緩和せず修正へ還流した。

## Evidence

- `docs/evidence/2026-07-22-ace-035-phase3-harness-readiness.md`
- `docs/evidence/aishell-representative-suite-freeze-20260721.md`
- `docs/adr/0011-run-check-freshness-cache-contract.md`
- `docs/adr/0012-change-impact-contract.md`
- `docs/adr/0013-focused-check-contract.md`

## Consequences

Phase 3のharnessとcorrectness gateは閉じる。全32 task product gateと公開releaseはPhase 7で別に受け入れる。
