#!/usr/bin/env node

import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
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

console.log("npm package metadata and payload are consistent.");
