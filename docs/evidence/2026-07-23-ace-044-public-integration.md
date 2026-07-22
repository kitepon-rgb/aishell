# ACE-044 公開tool統合証拠

- Date: 2026-07-23
- Lattice plan: `aishell-capability-expansion`
- Task: `ACE-044`

## 実装

- `workspace_wait`をexpanded capabilityの公開MCP toolへ統合し、保持済みjournalを消費せず待機する。
- `run_check dispatch:start`を永続sidecarへ接続し、`run_observe`の`status / read / wait / cancel`からadapter request寿命と独立して観測する。
- terminal publicationへproject ID、永続store identity digest、実行binding、expiry、stdout/stderr/diagnostic identityを固定する。
- `artifact_read`のv1 `range / tail / around`を変更せず、expanded capabilityだけに`search / next / compare`を追加する。
- artifact queryはterminal managed runだけをsourceにし、legacy unbound、別project/store、期限切れ、未finalizeをtyped errorで拒否する。live spoolへのfallbackは行わない。
- MCP request schedulerは独立taskでrequestを処理し、同時requestとnotificationをstdio writerで直列化する。

## 検証

関連suiteを一回実行した。

```text
swift test --filter 'ArtifactQueryServiceTests|ManagedRunArtifactStoreTests|ManagedRunServiceTests|MCPRunCheckV2WireTests|MCPRunCheckV2SchemaTests|MCPTypesTests'
```

結果は37 tests、failure 0。公開wire fixtureで次を実測した。

1. `run_check dispatch:start`で実processをsidecar起動する。
2. `run_observe wait/read`で増分stdoutを取得する。
3. terminal publication後、同じrun IDのstdoutを`artifact_read search`する。
4. 1 byte page上限で認証cursorを使い`next`へ進み、2件を重複・欠落なく取得する。
5. 同一terminal runのstdout/stderrを`compare`し、raw SHA/sizeとbinding差を返す。

追加fixtureで以下を確認した。

- baseline tool catalogとv1 artifact schemaは不変。
- expanded artifact input/outputはclosed union。
- tampered cursor、別stream cursor、binary insensitive/regexをtyped rejection。
- legacy unbound artifact、別project、期限切れrunを部分成功にしない。
- 公開artifactのSHA改変を`EVIDENCE_CORRUPT`相当として検出する。

## 構成証拠

- workspace wait checkpoint: `57be375`
- managed run lifecycle checkpoint: `08ca0e6`
- 本文書とartifact query production integrationは同一の後続checkpointに含める。
