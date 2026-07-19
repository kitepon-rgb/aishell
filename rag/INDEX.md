# RAG Index

- [GitHub公開repository設定](github-public-repository-settings.md) — private vulnerability reportingのAPI契約とSocial previewのUI制約・受入方法を記録（2026-07-19、確度: 高）
- [GitHub Actions macOS CI選定](github-actions-macos-ci.md) — 公開repo向けM1 arm64の`macos-15`を採用し、toolchain versionをjob logへ残す。`macos-latest`とpublish操作は通常CIから除外（2026-07-19、確度: 高）
- [AIShell macOS直結・開発効率ランタイム調査](development-efficiency-runtime.md) — Direct OS状態所有を根にした5 toolを実装。同一candidate 3×3 sentinelは両arm 9/9、token/solved task 25.86%減・平均wall 32.59%減（2026-07-19、確度: 中〜高）
- [macOS向けAI OSランタイム 初期機能調査 v0.2](macos-ai-os-runtime/research-synthesis.md) — Apple/MCP/OpenAI公式仕様、既存実装、macOS/OS操作ベンチマーク、安全性研究から初期採用・初期除外・受入条件を導出し、能力優先の製品判断を追記（2026-07-19、確度: 中〜高）
- [AIShellをCodexの別タスクへ公開する](codex-mcp-registration.md) — npm版stdio MCP登録、default 5 development + 2 recovery/full 25 tool、Git worktree実効root自動反映（2026-07-20、確度: 高）
- [AIShell npm配布判断](npm-distribution.md) — native MCPと明示的app launcherによる副作用なしのglobal install、0.3.1配布判断と実測（2026-07-19、確度: 高）
