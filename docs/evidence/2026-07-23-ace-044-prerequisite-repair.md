# ACE-044 prerequisite repair証拠

- 取得日: 2026-07-23（Asia/Tokyo）
- Lattice CLI: `@quolu/lattice@0.12.6`
- predecessor plan: `rev-b8dd5d4cfaf9b5eda89a575f`
- successor plan: `rev-cdb674945677d600567b967a`
- revision digest: `59c756da56ad749af357cd900dea09173f8bc8d91ad3d92f429470a2092881d0`
- commit receipt: `5709f3238e239d6e5e61c51bc044f4feb96442f6afa70ac5cfc75846d9560bc8`
- source cutover receipt: `bd7af12f8c235ff852aedb72371a963a7522fa453596098ac89b14d430e0fd27`

## 発見した不整合

ADR 0010、0014、0016はbenchmark v2 freezeと共通WorkspaceDeltaJournalを統合実装前の
hard predecessorに要求していた。しかし旧planではACE-044の直接依存がACE-041/042だけで、
freeze task自体が存在しないままACE-023cが完了し、ACE-044が開始されていた。

旧ACE-044は理由付きblockをsequence 29へ記録し、履歴を削除せずphase revisionで是正した。

## 追加・再受入する工程

- ACE-006: benchmark v2 execution contract / materializer / observer projection / digest freeze
- ACE-014: effective-root catalogとdurable WorkspaceDeltaJournal
- ACE-044c: `workspace_wait`とdurable cursor/gap/timeout/cancel
- ACE-044d: MCP request cancellation / single writer scheduler
- reset: ACE-023c、ACE-023、ACE-024、ACE-044

ACE-023cのhard predecessorはACE-006/014/022、ACE-044はACE-006/014/041/042となった。
Phase 0/1のaccepted stateは保持し、変更対象のPhase 2/4だけをactiveへ戻した。

## 検証

`lattice todo verify --plan aishell-capability-expansion --json`は次を返した。

- active task: 54
- source inventory: 54
- snapshot stale: false
- reconciliation state: reconciled
- next ready: ACE-006、ACE-014、ACE-044d

これにより、実装後の観測値へbenchmark v2を合わせる経路を閉じ、freeze済み入力から統合を再受入する。
