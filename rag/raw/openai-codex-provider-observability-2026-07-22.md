# OpenAI Codex provider observability source note

- 出典: https://learn.chatgpt.com/docs/config-file/config-advanced.md
- 補助実装参照: https://github.com/openai/codex
- 取得日: 2026-07-22
- 確度: 高（OpenAI公式文書＋手元Codex CLI 0.144.6実測）

## 一次仕様の要点

CodexはOpenTelemetryでAPI request、SSE event、tool result等を観測でき、run metadataへmodel情報を含める。公開文書はprovider responseの完全body保存までは保証しない。

## 手元実測

隔離した`codex exec --json --ephemeral`へ`RUST_LOG=tungstenite::protocol=trace`を付与すると、stderrのWebSocket受信traceにprovider由来の`response.created`／`response.completed` JSONが残った。両eventの`response.model`は`gpt-5.6-sol`で一致し、completed eventにはprovider usageが含まれた。全targetを有効にする`RUST_LOG=trace`は認証headerを含み得るため禁止する。

stdout JSONLのrequested modelや`turn_context.model`はactual provider証拠に使わない。`response.created/completed`だけをraw stderrからbyte抽出して専用JSONLへ保存し、そのSHA-256とstdout traceのSHA-256へmodel evidenceを結合する。WebSocket trace行そのものは通常stderr成果物へ残さない。
