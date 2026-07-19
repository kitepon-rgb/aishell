# ADR 0002: GitHub public polish acceptance

- Status: accepted
- Date: 2026-07-19
- Control: `aishell-github-public-polish-20260719`

## Decision

AIShellの公開OSS面を次の状態で受け入れる。

1. 英語READMEを主版、日本語READMEを対応版とし、30秒導線、比較表、Mermaid architecture、実行境界、既知制限を公開する。
2. 1280×640の生成画像をREADME heroとGitHub Social previewへ使い、再生成用CoreGraphics scriptを保持する。
3. Apache License 2.0を採用し、repositoryとnpm package metadataを一致させる。
4. Contribution、private security reporting、YAML Issue Forms、pull-request templateを公開する。執行主体と連絡先を裁定していないCode of ConductはCommunity Profileの数値目的で追加しない。
5. GitHub Actionsはpublic Apple Silicon `macos-15` runnerでSwift test、app packaging、npm payloadを確認する。実`rg` workerを使うtestのため、ripgrepをworkflowが明示導入する。
6. 既存`v0.3.0`は移動せず、公開済みfactory diagnostics版を保持する。`v0.3.1`はnpmの`gitHead=20ef0ce8fb6ef6551e42e64c6240977d7c28339d`、`v0.3.2`はnpmの`gitHead=775abd278f983519663e6903f1345c59904c2b27`へ対応させる。
7. GitHub Releases 0.3.0、0.3.1、0.3.2を公開し、0.3.2をlatestとする。npm `@quolu/aishell@0.3.2`もlatestとする。
8. Discussions、Projects、Wikiは空の運用入口を作らないため無効のまま維持する。Issues、private vulnerability reporting、secret scanning、push protectionを公開窓口と安全網にする。

## Acceptance evidence

- Public release commit: `775abd278f983519663e6903f1345c59904c2b27`
- CI environment fix: `5846400c6e8df465d3141388d5eff8e2926df649`
- Successful GitHub Actions run: `29688309075`
- npm 0.3.2 shasum: `1ca7c86546204e1ff096c60cda30d4338f788879`
- npm 0.3.2 license: `Apache-2.0`
- dotagents skill update: `70deaa5eba08b1560294c088fb92c0ba11174994`

## Consequences

`main`は0.3.2 tagよりCI環境修正と本受入記録の分だけ先行するが、runtimeとnpm payloadは変更しない。0.3.2 tagはnpm `gitHead`との一致を優先し、付け替えない。

Community Profileの百分率は受入条件にしない。GitHub APIがYAML Issue Formsをlegacy template欄へ算入しないことと、Code of Conductを意図的に置かないことを未完成扱いへ混ぜない。
