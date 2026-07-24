# Phase 7 full regression（0.3.5）

- Date: 2026-07-24
- 対象commit: `f59cbb9`（0.3.5）とその修正元 `1beb6e6`・`794b7ae`
- 用途: phase-7受入のfull-regression slot

## Swift全体

`swift test`: **538 tests / 0 failures**。apply_change_setの`after_content`追加と
per-change `result`削除、recovery/replay経路の変更を含む全suiteがgreen。

## Package・release・install

- `npm run test:package`: production app build、code signing、npm payload生成、metadata検証すべて成功
- `npm publish`: `@quolu/aishell@0.3.5`公開。registry実測 `gitHead=f59cbb9ca8c11af51efb5f83f0e29cf2bb19decb`、
  `dist-tags.latest=0.3.5`、shasum `888ab48bc0ace74ccf680ff11d217856833d0fd5`
- `npm install -g @quolu/aishell@0.3.5`: global install成功

## Installed wire fixture

`/opt/homebrew/bin/aishell-mcp`（installed 0.3.5）に対しJSON-RPC実測:

- server version: `0.3.5`
- protocol: `2025-11-25`
- `AISHELL_CAPABILITY_SET=expanded-v1`: 11 tools
- input/output schema欠落: 0
- tool catalog digest: `a7fb8c...`（0.3.4と一致、契約不変）

## Benchmark harness focused tests

- test-representative-acceptance-aggregate / production-runner / production-harness /
  binary-bindings / phase3-codex-executor / rebind-representative-candidate /
  phase3-representative-runner / phase3-acceptance-aggregate / phase3-local-callbacks: すべてpass
