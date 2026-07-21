#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const fixtureURL = new URL(
  "../Tests/AIShellCoreTests/Fixtures/workspace-checkpoint-cases.v1.json",
  import.meta.url,
);
const fixture = JSON.parse(await readFile(fixtureURL, "utf8"));

assert.equal(fixture.schema, "aishell.workspace-checkpoint-cases.v1");
assert.equal(
  fixture.contract,
  "docs/adr/0006-persistent-workspace-checkpoint-contract.md",
);

const requiredCases = new Set([
  "cold-start-missing",
  "warm-restore-unchanged",
  "offline-modify",
  "offline-same-size-mtime-modify",
  "offline-create-delete-rename",
  "event-gap",
  "event-store-uuid-changed",
  "root-replaced",
  "corrupt-payload",
  "unsupported-schema",
  "migration-failed",
  "single-root-quota-exceeded",
  "atomic-replace-failed",
]);
const cases = new Map();
for (const item of fixture.cases) {
  assert.equal(typeof item.id, "string");
  assert.ok(!cases.has(item.id), `duplicate case: ${item.id}`);
  assert.equal(typeof item.condition, "string");
  assert.ok(item.condition.length > 0);
  assert.equal(typeof item.expected?.decision, "string");
  assert.equal(typeof item.expected?.reuse_entries, "boolean");
  cases.set(item.id, item);
}
assert.deepEqual(new Set(cases.keys()), requiredCases);

for (const item of cases.values()) {
  const { expected } = item;
  if (expected.decision === "stop") {
    assert.match(expected.typed_error, /^[A-Z][A-Z0-9_]+$/);
    assert.equal(expected.reuse_entries, false);
  } else {
    assert.equal(expected.typed_error, null);
  }
}

assert.deepEqual(cases.get("offline-same-size-mtime-modify").expected.rehash, ["State.bin"]);
assert.equal(cases.get("corrupt-payload").expected.preserve_checkpoint, true);
assert.equal(cases.get("unsupported-schema").expected.preserve_checkpoint, true);
assert.equal(cases.get("migration-failed").expected.preserve_checkpoint, true);
assert.equal(cases.get("single-root-quota-exceeded").expected.preserve_previous, true);
assert.equal(cases.get("atomic-replace-failed").expected.preserve_previous, true);

process.stdout.write(
  JSON.stringify({
    schema: "aishell.workspace-checkpoint-safety-net-result.v1",
    fixture: fileURLToPath(fixtureURL),
    cases: cases.size,
    required_cases: requiredCases.size,
    silent_fallbacks: 0,
    status: "passed",
  }) + "\n",
);
