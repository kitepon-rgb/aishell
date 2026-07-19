# High-density runtime safety net

- Control: `aishell-efficiency-20260719`
- Observed: 2026-07-19
- Command: `swift test --filter 'EvidenceStoreTests|DevelopmentRuntimeServiceTests'`
- Result: expected red, exit code 1.

The pre-implementation tests define the first vertical slice's non-negotiable behavior:

- retained artifact bytes are lossless;
- range, tail, and pattern-context reads obey an explicit byte budget;
- omission is counted rather than silently truncated;
- expired handles fail as `handleExpired`;
- a successful direct process returns a sub-128-byte summary and a retrievable stdout handle;
- a failed direct process returns a failed status while retaining its stream evidence.

The compiler failed only because `EvidenceStore`, `DevelopmentRuntimeService`, their result types, and `AIShellError.handleExpired` do not exist yet. This is the intended red state before implementation; the previous full baseline remains green at 16 tests.
