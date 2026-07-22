# ACE-023 context integration reacceptance

- Lattice task: `ACE-023`
- Date: 2026-07-23
- Integration provenance: `4c7e61d`、`d665f07`
- Original Phase 2 focused acceptance provenance: `df720ce`
- Repaired predecessors: benchmark freeze `1bc8efa`、shared retained view `9776af6`、search v2 reacceptance `d61f08f`

## 再受入理由

旧plan revisionではGit diff、project profile、SearchContextService v2の`ContextCompilerService`／MCP統合は完了していた。
その後、benchmark v2 freezeと共通`WorkspaceDeltaJournal`がhard predecessorから欠落していたことが判明したため、plan revisionで
`ACE-023`をpendingへ戻した。本証拠は欠落predecessorを実装・受入した後の再検証であり、旧完了状態の流用ではない。

## focused verification

```text
swift test --filter 'Phase2AcceptanceTests|ContextCompilerServiceTests|MCPContextV2WireTests'
Executed 17 tests, with 0 failures
```

確認した境界:

- workspace snapshot v2へGit diffとproject profileを加算し、v1 fieldを削除しない。
- Git diffとproject profileのopaque continuationが同じsnapshot generationへ束縛される。
- search v2が専用serviceと共通retained observation viewを通る。
- snapshot consumer後もchanged search cursorがdrilldownに利用できる。
- MCP tools/list、成功result、typed failureのwire shapeが安定している。
- integrated contextのrecallとcontinuationを維持し、fixture上のmodel-visible callはnative 5回に対してAIShell 2回。

テスト出力の`token_measurement`は`not_measured`であり、このfocused fixtureだけからtoken削減率を主張しない。provider報告tokenを使う
paired benchmarkとPhase 2 accept/rejectは`ACE-024`で行う。

production code変更は不要だった。新predecessor下で17件すべてが通ったため、統合境界の追加修正は実施していない。
