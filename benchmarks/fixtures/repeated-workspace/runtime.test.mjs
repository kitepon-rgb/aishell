import assert from "node:assert/strict";
import test from "node:test";
import configuration from "./runtime-config.json" with { type: "json" };
import { accepts, supportedProtocolVersion } from "./runtime.mjs";

test("protocol version 2 is consistently advertised", () => {
  assert.equal(configuration.protocolVersion, 2);
  assert.equal(supportedProtocolVersion, 2);
  assert.equal(accepts(2), true);
  assert.equal(accepts(1), false);
});
