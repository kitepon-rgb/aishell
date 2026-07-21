# ADR 0005: Phase 0受入

- Status: accepted
- Date: 2026-07-21
- Control: `aishell-capability-expansion-20260721`
- Lattice plan: `aishell-capability-expansion`
- Lattice phase: `phase-0`

## Decision

Phase 0「再baseline・測定契約・公開surface固定」を受け入れる。

受入対象は、現行0.3.3 baseline、32 task × 3 arm × 3反復の比較契約、expanded development surface 9 tool、
既存能力の非削減表、日英20 discovery probe、workspace cursor v2契約とcharacterizationである。
効率化は重複scan、重複tool call、証拠の二重化を削減するが、S〜Bの能力、既存5 tool、復旧control、
full profileのlegacy primitiveを削減しない。

requestはfixture、pre-attempt manifest、baseline manifest、setup evidenceから決定的に再生成し、raw traceと照合する。
discovery gateはcandidateだけへ適用し、model-visible入力へprobe ID、期待tool、禁止候補を渡さない。
positive probeは期待toolちょうど1回、no-call controlは0回だけを成功とする。

## Evidence

- `docs/evidence/aishell-capability-expansion-baseline-20260721.md`
- `docs/evidence/aishell-representative-suite-freeze-20260721.md`
- `docs/evidence/aishell-phase-0-gate-20260721.md`
- `docs/adr/0003-expanded-development-surface-contract.md`
- `docs/adr/0004-workspace-cursor-v2-contract.md`

独立反証はblocker 0で受入可と判定した。benchmark契約の6 gate、`swift test` 50件、
WorkspaceStateRuntime focused 15件、Lattice store verifyはすべてgreenである。

## Consequences

Phase 1〜5の契約裁定と実装を開始できる。expanded surfaceのdefault昇格、288 attemptの実測、
30% token削減product gate、公開releaseは未達であり、後続Phaseの受入条件を縮小しない。
