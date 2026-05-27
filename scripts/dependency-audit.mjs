#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = fileURLToPath(new URL("..", import.meta.url));
const packageJson = JSON.parse(await readFile(join(rootDir, "package.json"), "utf8"));
const packageLock = JSON.parse(await readFile(join(rootDir, "package-lock.json"), "utf8"));

const runtimeDependencyFields = [
  "dependencies",
  "optionalDependencies",
  "peerDependencies",
  "bundledDependencies",
  "bundleDependencies"
];
const allowedLicenses = new Set([
  "Apache-2.0",
  "BlueOak-1.0.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "ISC",
  "MIT",
  "Python-2.0"
]);

const runtimePackages = collectRuntimePackages();
assert.deepEqual(
  runtimePackages,
  [],
  `Production dependency surface must stay empty; found ${runtimePackages.join(", ")}`
);

const licenseCounts = collectLicenseCounts();
const unknownLicenses = [...licenseCounts.keys()].filter((license) => !licenseAllowed(license));
assert.deepEqual(
  unknownLicenses,
  [],
  `Dependency license allowlist needs review for: ${unknownLicenses.join(", ")}`
);

const summary = [...licenseCounts.entries()]
  .sort(([left], [right]) => left.localeCompare(right))
  .map(([license, count]) => `${license}: ${count}`)
  .join(", ");

console.log("Dependency policy audit passed");
console.log(`Production dependencies: ${runtimePackages.length}`);
console.log(`Dev dependency package licenses: ${summary}`);

function collectRuntimePackages() {
  const rootLockPackage = packageLock.packages?.[""] || {};
  const runtime = new Set();
  for (const field of runtimeDependencyFields) {
    for (const name of Object.keys(packageJson[field] || {})) {
      runtime.add(`${field}.${name}`);
    }
    for (const name of Object.keys(rootLockPackage[field] || {})) {
      runtime.add(`package-lock:${field}.${name}`);
    }
  }
  for (const [path, metadata] of Object.entries(packageLock.packages || {})) {
    if (path.startsWith("node_modules/") && metadata.dev !== true) {
      runtime.add(`package-lock:${path}`);
    }
  }
  return [...runtime].sort();
}

function collectLicenseCounts() {
  const counts = new Map();
  for (const [path, metadata] of Object.entries(packageLock.packages || {})) {
    if (!path.startsWith("node_modules/")) {
      continue;
    }
    const license = metadata.license;
    assert.equal(typeof license, "string", `${path} is missing license metadata`);
    counts.set(license, (counts.get(license) || 0) + 1);
  }
  return counts;
}

function licenseAllowed(licenseExpression) {
  const identifiers = licenseExpression
    .replace(/[()]/g, " ")
    .split(/\s+(?:AND|OR|WITH)\s+|\s+/)
    .filter(Boolean);
  return identifiers.length > 0 && identifiers.every((identifier) => allowedLicenses.has(identifier));
}
