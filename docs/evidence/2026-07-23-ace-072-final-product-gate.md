# ACE-072 最終product gate

- Date: 2026-07-23
- Lattice task: `ACE-072`
- Benchmark: 未実行。全製品工程後に目的・規模・所要時間を説明し、オーナーが明示了承した場合だけ実行する。

## Maintenance

独立監査で、未知値または空の`AISHELL_TOOL_PROFILE`がdevelopment profileへ黙って
fallbackする契約違反を1件検出した。`ToolCatalog.listedTools`で未指定、
`development`、`full`、`legacy`だけを受理し、それ以外は
`INVALID_TOOL_PROFILE`でstartup停止するように修正した。

focused testはcatalog、startup validation、tool callの各経路で未知値と空文字を確認する。
修正後の独立再監査はblocker解消、残存する重大blockerなしと判定した。

## 検証

- benchmark observer/oracle focused:
  - `node benchmarks/test-capability-observer.mjs`
  - `node benchmarks/test-capability-oracle.mjs`
  - failure 0
- product test: `swift test`
  - 537 passed / 0 failed
  - 同じrunにCoreとMCP wire testsを含む
- profile focused: `swift test --filter MCPTypesTests`
  - 8 passed / 0 failed
- release app: `scripts/package-app.sh release`
  - production build、code signing、`build/AIShell.app`生成に成功
- release binary wire:
  - MCP protocol `2025-11-25`
  - baseline development: 7 tools
  - `expanded-v1` development: 11 tools（高密度9 + recovery control 2）
  - `expanded-v1` full: 29 tools
  - expanded developmentのinput/output schema欠落: 0
  - 未知値と空の`AISHELL_TOOL_PROFILE`: `INVALID_TOOL_PROFILE`
- Lattice: `lattice todo verify --json`
  - `snapshot_stale=false`
  - `reconciliation_state=reconciled`
  - source inventory 54

## 独立監査

ChatGPT connectorは専用Chrome page不在、Codex sidecarはproject設定不在のため、いずれも
送信前に停止した。暗黙fallbackや設定追加は行わず、read-only native refuterで監査した。
refuterはテスト、benchmark、編集を行っていない。

初回監査のprofile blockerを上記のとおり修正し、同じrefuterの再監査で解消を確認した。
ほかの重大blockerは検出されなかった。
