# ACE-060 diagnostic adapter証拠

- Date: 2026-07-23
- Task: `ACE-060`

`DiagnosticAdapterService`へxcresult JSON、SARIF、Cargo compiler-message JSON lines、Bazel BEP JSON linesのadapterを実装した。
全formatを`aishell.diagnostics.v1`のseverity、message、rule ID、path、line、column、content SHAへ変換する。
workspace内fileは現在のraw bytesからSHA-256を計算して束縛し、root外又は欠落pathへ架空SHAを付けない。
空又は不正formatはtext fallbackせず`DIAGNOSTIC_PARSE_FAILED`として拒否する。

```text
swift test --filter DiagnosticAdapterServiceTests
```

2 tests、failure 0。Xcode/SARIFのpath・位置・SHA、Cargo/Bazelの共通schema、malformed SARIFのfail closedを確認した。

