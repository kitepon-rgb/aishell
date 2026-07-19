# Initial high-density surface final audit

- Date: 2026-07-19
- Candidate: `a0c22c3`
- Scope: five-tool development profile, OS-owned runtime, benchmark validity, 0.3 distribution

An independent read-only adversarial audit found and drove fixes for context payload duplication, process-tree timeout races, immutable artifact metadata, FSEvents path aliases and rename paging, initial triple scan, gap recovery, continuation integrity, UTF-8 budgets, hidden development files, schema ranges/types, strict JSON-RPC errors, and benchmark false-success paths.

Final conclusion: no unresolved blocker remains for the initial five-tool surface. After the formal benchmark and final annotation change, `swift test` passed 42/42. The production npm package, ad-hoc signature, default five-tool catalog, full 25-tool profile, MCP version 0.3.0, unknown/malformed request handling, and package metadata were verified again as the closing gate.

Known non-blocking limits are explicit in the ADR and release notes: bounded initial snapshot preview, serial stdio request handling, no MCP cancellation/concurrent polling, and destructive/open-world approval behavior for arbitrary workers.

## 0.3.1 release follow-up

The 0.3.1 patch documents shell/env basename denial as a product rail rather than a security boundary; runtime behavior is unchanged. The release candidate passed all 42 Swift tests, npm payload verification, strict deep code-signature verification, MCP initialize version 0.3.1, default five-tool discovery, and full 25-tool discovery. The dry-run package contains seven expected entries, is 835,796 bytes packed, and has no lifecycle install script.
