# AIShell capability expansion baseline

- 記録日: 2026-07-21
- Git HEAD: `2705b407cde704873c40b833507059eba99a1a82` (`v0.3.3`)
- upstream差分: `origin/main...HEAD = 0 0`
- Lattice CLI: `0.11.0`
- Lattice plan: `aishell-capability-expansion`
- plan version: `rev-a4f1cb69ad348f1c553d7e2c`
- manifest SHA-256: `9cd0187c6abdb22fd2d3b8b79c377a23db4321591aa742afe0bd1e8885b6fdc4`

## Test baseline

`swift test list`で42 testを列挙し、`swift test`で42件すべてが成功した。

- executed: 42
- failures: 0
- unexpected failures: 0

## M1 evidence binding

- evidence: `docs/evidence/aishell-efficiency-m1-benchmark.md`
- SHA-256: `78874905f81ef289560c412f09aab08a547e6fbabebdfebdcc942cdb499fefd6`
- formal run: native/AIShell両arm 9/9成功
- tokens per solved task: 25.86%削減
- mean wall time: 32.59%削減
- 限界: 3 sentinelの既存M1証拠であり、30 task以上のproduct gateとは扱わない

## Control declaration

- control ID: `aishell-capability-expansion-20260721`
- Control revision: 1
- risk: `high`
- behavior lane: `behavior-change`
- base SHA: `2705b407cde704873c40b833507059eba99a1a82`
- initial dirty: `true`（Lattice工程storeと計画改訂を開始済みのため）

この証拠はACE-001の再baselineだけを受け入れる。後続機能、30 task代表suite、最終product gateの成功は主張しない。
