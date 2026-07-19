import assert from "node:assert/strict";
import test from "node:test";
import { inclusiveSum } from "./math.mjs";

test("inclusive endpoints", () => {
  assert.equal(inclusiveSum(2, 4), 9);
  assert.equal(inclusiveSum(-1, 1), 0);
});
