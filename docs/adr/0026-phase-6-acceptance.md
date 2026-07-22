# ADR 0026: Phase 6受入

- Status: accepted
- Date: 2026-07-23
- Lattice plan: `aishell-capability-expansion`
- Lattice phase: `phase-6`

## Decision

Phase 6「adapter・semantic・worktree統合」を受け入れる。expanded developmentは高密度9 tool＋復旧control 2、
expanded fullは29 toolを契約順で返し、baseline 7/full 25の互換面を維持した。

日英20 discovery probeは20/20、誤routing 0、期待tool後の不要call 0。SourceKit-LSP、build manifest、depfile、
static importのproviderはfile SHA/freshnessへ束縛し、ablation結果に基づきdefault routingはfilesystem＋static importのまま維持した。
branch/worktree比較はrepo identity、base ref、dirty state、budgeted diffを返す。run_checkは完全診断保持をsummaryで明示し、
不要なartifact再読を抑制する。

## Evidence

- `docs/evidence/2026-07-23-ace-065-phase-6-acceptance.md`
- `docs/evidence/data/ace-065-tool-discovery-model-results.json`
- `docs/evidence/2026-07-23-ace-061-sourcekit-lsp.md`
- `docs/evidence/2026-07-23-ace-062-impact-providers.md`
- `docs/evidence/2026-07-23-ace-063-worktree-branch-comparison.md`
- `docs/evidence/2026-07-23-ace-064-provider-ablation.md`

## Consequences

Phase 7の30 task以上×事前登録反復、30% product gate、全体test/package/wire監査、公開docs/releaseへ進める。
native shellとの競合はPhase 7 tool adoptionで実測し、Phase 6 discovery値だけで製品効果を主張しない。
