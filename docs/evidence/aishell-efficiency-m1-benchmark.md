# High-density runtime benchmark evidence

- Control: `aishell-efficiency-20260719`
- Date: 2026-07-19
- Codex: `codex-cli 0.144.6`
- Model: `gpt-5.6-sol`, reasoning `medium`
- Isolation: `--ephemeral --ignore-user-config --ignore-rules`, approval/sandbox bypass inside disposable deterministic fixtures, per-run state directory
- Primary formula: total tokens across all attempts / deterministic oracle successes

## Valid capability evidence

The final candidate completed all five tools in one isolated Codex run. The oracle now requires each named tool to finish successfully, rather than checking only that the fixture remained unchanged.

The default profile contains five tools. The full compatibility profile contains 25. `TextContent` carries model-facing payload while `structuredContent` removes duplicated artifact/context/search text.

The host has no `rtk` executable. The runner records the inherited `PATH` hash and RTK detection result and refuses a formal run if RTK is found. Codex native output handling remains part of the native product baseline.

## Invalid exploratory evidence

Earlier runs found useful defects: forced routing hurt tiny tasks, high-volume diagnostics justified retained artifacts, and missing PATH ownership caused retries. However, the published 1.54% token increase / 11.3% time reduction combined records from different binary hashes and post-hoc prompt/PATH changes. That aggregate is invalid and is not release evidence.

## Formal run

One same-invocation run covered both arms, three sentinel tasks, and three repetitions using one binary, prompt manifest, repository state, timeout, and model configuration. AIShell routing was oracle-gated per task (`run_check` for noisy compile; `workspace_snapshot` for repeated workspace observation).

Provenance:

- repository commit: `a0c22c3f2254e5fdf151ffefc4771d7907759111`, clean for every run
- AIShell binary SHA-256: `ace89c0076325b0860091895b07eb499f62e144a72b374673bb1013689050713`
- manifest SHA-256: `61cd99dbfdaf7bbeb08299bab715446c2f958f3dddb6c68c0b79e37a0f8d038e`
- runner SHA-256: `e17a55f36276b22bb29bae70a3ebfe6a618ccfdf9107f8f0e9163a8e2cc5fd7d`
- RTK executable: absent; inherited PATH hash recorded
- agent timeout/non-zero exit/tool error: zero
- report: [`benchmarks/final-report.json`](../../benchmarks/final-report.json)

| Metric | Native | AIShell | Change |
|---|---:|---:|---:|
| oracle success | 9/9 | 9/9 | non-inferior |
| tokens / solved task | 144,251 | 106,955 | 25.86% lower |
| mean wall time | 50.14s | 33.80s | 32.59% lower |
| p50 wall time | 48.43s | 31.99s | 33.95% lower |
| p95 wall time | 72.49s | 43.54s | 39.93% lower |

| Task | Native tokens | AIShell tokens | Token change | Native time | AIShell time | Time change |
|---|---:|---:|---:|---:|---:|---:|
| tiny code change | 123,638 | 101,507 | 17.90% lower | 32.81s | 28.14s | 14.24% lower |
| noisy compile failure | 166,967 | 105,775 | 36.65% lower | 67.73s | 32.50s | 52.01% lower |
| repeated workspace | 142,147 | 113,581 | 20.10% lower | 49.86s | 40.75s | 18.28% lower |

M1 passes its 20% token-reduction target while preserving correctness. The strongest causal evidence is the noisy compile task: `run_check` retained 216 KB diagnostics outside normal model context and returned the primary failure. `workspace_snapshot` also passed its required routing gate and improved the repeated-workspace task.

Limits: only three deterministic tasks were measured; Codex model variance was material; the benchmark used dangerous bypass mode equally for both arms inside disposable trusted fixtures because truthful `run_check` annotations are destructive/open-world. In the tiny task the model still chose `workspace_snapshot` in two of three AIShell runs, so adaptive routing is not yet deterministic. These results justify the initial surface, not a universal 25.86% claim.
