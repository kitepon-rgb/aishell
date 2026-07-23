# RAG Index

- [GitHub公開repository設定](github-public-repository-settings.md) — private vulnerability reportingのAPI契約とSocial previewのUI制約・受入方法を記録（2026-07-19、確度: 高）
- [GitHub Actions macOS CI選定](github-actions-macos-ci.md) — 公開repo向けM1 arm64の`macos-15`を採用し、toolchain versionをjob logへ残す。`macos-latest`とpublish操作は通常CIから除外（2026-07-19、確度: 高）
- [AIShell macOS直結・開発効率ランタイム調査](development-efficiency-runtime.md) — Direct OS状態所有を根にした5 toolを実装。同一candidate 3×3 sentinelは両arm 9/9、token/solved task 25.86%減・平均wall 32.59%減（2026-07-19、確度: 中〜高）
- [macOS向けAI OSランタイム 初期機能調査 v0.2](macos-ai-os-runtime/research-synthesis.md) — Apple/MCP/OpenAI公式仕様、既存実装、macOS/OS操作ベンチマーク、安全性研究から初期採用・初期除外・受入条件を導出し、能力優先の製品判断を追記（2026-07-19、確度: 中〜高）
- [AIShellをCodexの別タスクへ公開する](codex-mcp-registration.md) — npm版stdio MCP登録、default 7/full 25とexpanded-v1 development 11/full 29、typed startup failure、Git worktree実効root自動反映（2026-07-23、確度: 高）
- [AIShell npm配布判断](npm-distribution.md) — native MCPと明示的app launcherによる副作用なしのglobal install、0.3.1配布判断と実測（2026-07-19、確度: 高）
- [FSEvents永続checkpointの連続性](fsevents-persistent-checkpoint-continuity.md) — volume UUID、event ID巻戻り、drop、scan中eventをfail-closedなwarm restore契約へ反映（2026-07-21、確度: 高）
- [FSEvents device timestamp boundaryの実測制約](fsevents-device-boundary-observation.md) — timestamp検索の6秒超遅延と、UUID＋processed callback IDを永続cursorに使う判断（2026-07-21、確度: 高）
- [Codex provider SSE観測](codex-provider-sse-observability.md) — requested modelを使わずprovider WebSocket受信frameからactual modelを証明し、MCP original wire bytesと分離して保持する（2026-07-22、確度: 高）
