// verify-byte-identical.mjs — the byte-identity gate (public == shipping).
//
// Walks two engine trees, computes sha256 of every file, and compares the two
// manifests 1:1. Any mismatch, extra, or missing file => exit 1 (FAIL). A clean
// match => exit 0, which is the proof the staged public snapshot is exactly the
// engine the website ships.
//
// 0 dependencies: only node:fs / node:path / node:crypto (built-ins).
//
// Usage: node verify-byte-identical.mjs <sourceEngineDir> <stagedEngineDir>

import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

const [, , srcDir, destDir] = process.argv;
if (!srcDir || !destDir) {
  console.error("usage: node verify-byte-identical.mjs <sourceEngineDir> <stagedEngineDir>");
  process.exit(2);
}

// Recursively list files relative to `root`, using forward slashes so the two
// manifests compare cleanly regardless of OS path separator.
function listFiles(root) {
  const out = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir).sort()) {
      const abs = join(dir, name);
      if (statSync(abs).isDirectory()) walk(abs);
      else out.push(relative(root, abs).split(sep).join("/"));
    }
  };
  walk(root);
  return out.sort();
}

function sha256(absPath) {
  return createHash("sha256").update(readFileSync(absPath)).digest("hex");
}

const srcFiles = listFiles(srcDir);
const destFiles = listFiles(destDir);

const srcSet = new Set(srcFiles);
const destSet = new Set(destFiles);

const missing = srcFiles.filter((f) => !destSet.has(f)); // in source, not staged
const extra = destFiles.filter((f) => !srcSet.has(f)); // staged, not in source
const mismatched = [];

for (const f of srcFiles) {
  if (!destSet.has(f)) continue;
  if (sha256(join(srcDir, f)) !== sha256(join(destDir, f))) mismatched.push(f);
}

console.log(`source files: ${srcFiles.length}`);
console.log(`staged files: ${destFiles.length}`);

let failed = false;
if (missing.length) {
  failed = true;
  console.error(`\nMISSING from staging (${missing.length}):`);
  missing.forEach((f) => console.error("  - " + f));
}
if (extra.length) {
  failed = true;
  console.error(`\nEXTRA in staging (${extra.length}):`);
  extra.forEach((f) => console.error("  + " + f));
}
if (mismatched.length) {
  failed = true;
  console.error(`\nHASH MISMATCH (${mismatched.length}):`);
  mismatched.forEach((f) => console.error("  ! " + f));
}

if (failed) {
  console.error("\nFAIL: staged snapshot is NOT byte-identical to the shipping engine.");
  process.exit(1);
}

console.log(`\nOK: all ${srcFiles.length} files byte-identical (sha256 match, no extra/missing).`);
