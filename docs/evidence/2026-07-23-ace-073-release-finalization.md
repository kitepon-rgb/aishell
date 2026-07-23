# ACE-073 AIShell 0.3.4 release finalization

- Date: 2026-07-23
- Lattice task: `ACE-073`
- Source commit: `b4546ef30ba32ba9697ba829d53fd224992cda8b`
- npm package: `@quolu/aishell@0.3.4`
- npm integrity: `sha512-sJTGCML2PUKFVL+wnwqFMiQDc7CTTDyKO1vfHjKMDz4dZB3C1XQKf/xJYOwRJbXNMfz9SJbvca7T2k6M7cBRFg==`
- npm shasum: `9132924209f6a64183e4d1a68367a77c1fda2e35`

## Public surface

- README英日へbaseline default 7/full 25と、明示opt-inのexpanded development 11/full 29を同期した。
- MCP server、npm package、app short versionを0.3.4へ更新した。
- candidate toolはMCP `2025-11-25`のtop-level object `outputSchema`を持つ。
- 未知または空のcapability/profile値はtyped startup errorで停止し、silent fallbackしない。
- RAG index、Codex登録実測、release notesを0.3.4へ同期した。

## Packaging and release

- `npm run test:package`
  - production app build、code signing、npm payload生成、metadata検証に成功
- publish payload
  - 10 files
  - unpacked size 42.1 MB
  - `aishell-mcp`、`aishell-run-supervisor`、manager appを同梱
- `npm publish`
  - public registryへ0.3.4を公開
  - registryのintegrity、shasum、gitHeadは上記値と一致
- `npm install -g @quolu/aishell@0.3.4`
  - global install成功

## Installed wire fixture

`/opt/homebrew/bin/aishell-mcp`を実行して次を確認した。

- server version: `0.3.4`
- protocol: `2025-11-25`
- `AISHELL_CAPABILITY_SET=expanded-v1`: 11 tools
- input/output schema欠落: 0

## Control finalization

ACE-072のproduct gateと独立再監査は完了済み。ACE-073は公開文書、schema、commit、push、
npm release、global installを完了した。

代表benchmarkは実行していない。全製品工程後に目的・規模・所要時間を説明し、オーナーが
明示了承した場合だけ開始する。
