#!/usr/bin/env node
/**
 * Sync this package's `version` to match the resolved
 * `@anthropic-ai/claude-agent-sdk` version, so consumers can tell at a
 * glance which SDK an installed @hwisu/claude-agent-acp build wraps.
 *
 * Scheme:
 *   - Base version mirrors the SDK's `x.y.z` (e.g. SDK 0.2.132 → 0.2.132).
 *   - For fork-only patches between SDK releases, pass `--bump`. This appends
 *     (or increments) a `-N` prerelease suffix: 0.2.132 → 0.2.132-1 → 0.2.132-2.
 *   - `--check` exits non-zero when the base differs from the SDK (CI guard).
 *
 * Usage:
 *   node script/sync-sdk-version.mjs            # set version to SDK base
 *   node script/sync-sdk-version.mjs --bump     # bump the -N suffix
 *   node script/sync-sdk-version.mjs --check    # verify, don't write
 */

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const PKG_PATH = join(ROOT, "package.json");
const SDK_PKG_PATH = join(ROOT, "node_modules/@anthropic-ai/claude-agent-sdk/package.json");

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function writeJson(path, value) {
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n");
}

function parseVersion(v) {
  const m = v.match(/^(\d+\.\d+\.\d+)(?:-(\d+))?$/);
  if (!m) throw new Error(`Unrecognized version shape: ${v}`);
  return { base: m[1], patch: m[2] ? parseInt(m[2], 10) : null };
}

function formatVersion(base, patch) {
  return patch == null ? base : `${base}-${patch}`;
}

const args = new Set(process.argv.slice(2));
const sdk = readJson(SDK_PKG_PATH);
const pkg = readJson(PKG_PATH);

const sdkBase = sdk.version;
const current = parseVersion(pkg.version);
const baseChanged = current.base !== sdkBase;

let next;
if (args.has("--bump")) {
  // Fork-only patch: keep the SDK base, bump (or start) the -N suffix.
  // Reset suffix to 1 when the SDK base just moved forward.
  next = formatVersion(sdkBase, baseChanged ? 1 : (current.patch ?? 0) + 1);
} else {
  // Plain sync: track SDK base exactly, drop any prior -N suffix.
  next = sdkBase;
}

if (args.has("--check")) {
  if (pkg.version !== next) {
    console.error(`version drift: package=${pkg.version} expected=${next} (SDK=${sdkBase})`);
    process.exit(1);
  }
  console.log(`ok: version ${pkg.version} matches SDK ${sdkBase}`);
  process.exit(0);
}

if (pkg.version === next) {
  console.log(`already in sync: ${pkg.version}`);
  process.exit(0);
}

pkg.version = next;
writeJson(PKG_PATH, pkg);
console.log(
  `package.json version: ${current.base}${current.patch ? `-${current.patch}` : ""} → ${next} (SDK ${sdkBase})`,
);
