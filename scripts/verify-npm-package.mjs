#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectDirectory = path.dirname(scriptDirectory);
const packageMetadata = JSON.parse(
  await readFile(path.join(projectDirectory, "package.json"), "utf8")
);

assert.equal(packageMetadata.name, "@quolu/aishell");
// versionの単一正本はSwiftのAIShellProduct.version。package.jsonとの一致だけを検証し、
// releaseごとに書き換わるliteralをこのscriptへ二重化しない。
const factoryDiagnosticsSource = await readFile(
  path.join(projectDirectory, "Sources", "AIShellCore", "FactoryDiagnostics.swift"),
  "utf8"
);
const swiftVersion = factoryDiagnosticsSource.match(
  /public\s+static\s+let\s+version\s*=\s*"([^"]+)"/
)?.[1];
assert.ok(swiftVersion, "AIShellProduct.version must be declared in FactoryDiagnostics.swift");
assert.equal(packageMetadata.version, swiftVersion, "package.json must match AIShellProduct.version");
assert.deepEqual(packageMetadata.os, ["darwin"]);
assert.deepEqual(packageMetadata.cpu, ["arm64"]);
assert.equal(
  packageMetadata.bin["aishell-mcp"],
  "dist/AIShell.app/Contents/Helpers/aishell-mcp"
);
assert.equal(packageMetadata.bin["aishell-open"], "scripts/aishell-open.mjs");

await access(path.join(projectDirectory, packageMetadata.bin["aishell-mcp"]));

const infoPlist = await readFile(
  path.join(projectDirectory, "dist", "AIShell.app", "Contents", "Info.plist"),
  "utf8"
);

assert.match(
  infoPlist,
  new RegExp(`<key>CFBundleShortVersionString</key>\\s*<string>${packageMetadata.version}</string>`)
);
// CFBundleVersionはsemantic versionと独立したbuild番号なのでpackage.jsonから導出できない。
// Packaging/Info.plistを単一正本とし、payloadがそれと一致することだけを検証する。
const sourceInfoPlist = await readFile(
  path.join(projectDirectory, "Packaging", "Info.plist"),
  "utf8"
);
const bundleVersion = sourceInfoPlist.match(
  /<key>CFBundleVersion<\/key>\s*<string>(\d+)<\/string>/
)?.[1];
assert.ok(bundleVersion, "CFBundleVersion must be a positive integer in Packaging/Info.plist");
assert.match(
  infoPlist,
  new RegExp(`<key>CFBundleVersion</key>\\s*<string>${bundleVersion}</string>`)
);

// MCP hostは`aishell-mcp`をbare command名で起動する。argv[0]がpathを含まない起動形式でも
// AIShell.app bundleを解決できることを、payloadの実binaryで確認する。ここが緩むと工場診断が
// manager.application_bundle_unavailable を返し、reporterがAIShellをnot_readyと判定する。
const payloadBinary = path.join(
  projectDirectory, "dist", "AIShell.app", "Contents", "Helpers", "aishell-mcp"
);
const pathDirectory = await mkdtemp(path.join(tmpdir(), "aishell-verify-"));
try {
  await symlink(payloadBinary, path.join(pathDirectory, "aishell-mcp"));
  const request = [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: {
      protocolVersion: "2025-11-25", capabilities: {},
      clientInfo: { name: "verify-npm-package", version: "1.0.0" }
    } },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "factory_diagnostics", arguments: {} } }
  ].map((message) => JSON.stringify(message)).join("\n");

  const stdout = await new Promise((resolve, reject) => {
    const child = spawn("aishell-mcp", [], {
      env: { ...process.env, PATH: `${pathDirectory}:${process.env.PATH}`, AISHELL_TOOL_PROFILE: "factory" },
      stdio: ["pipe", "pipe", "ignore"]
    });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.on("error", reject);
    child.on("close", () => resolve(output));
    child.stdin.end(`${request}\n`);
  });

  const diagnostics = stdout.trim().split("\n")
    .flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } })
    .find((entry) => entry.id === 2)?.result?.structuredContent;

  assert.ok(diagnostics, "factory_diagnostics must respond when launched by bare command name");
  assert.equal(diagnostics.product.version, packageMetadata.version);
  assert.equal(
    diagnostics.manager.applicationBundleState,
    "available",
    "AIShell.app must resolve when argv[0] carries no directory component"
  );
  assert.ok(
    Object.values(diagnostics.privacy).every((exposed) => exposed === false),
    "factory diagnostics must not expose paths, history, file contents, or process arguments"
  );
  assert.doesNotMatch(stdout, /\/Users\//, "factory diagnostics must not emit absolute paths");
} finally {
  await rm(pathDirectory, { recursive: true, force: true });
}

console.log("npm package metadata and payload are consistent.");
