#!/usr/bin/env node
import { readdir, readFile } from "node:fs/promises";
import { extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = resolve(fileURLToPath(new URL("..", import.meta.url)));
const explicitFiles = [
  "CHANGELOG.md",
  "README.md",
  "eslint.config.mjs",
  "package.json",
  "package-lock.json",
  "plan-example.graph.json",
  "tsconfig.json"
];
const scannedDirs = ["docs", "prompts", "scripts", "tests"];
const scannedExtensions = new Set([".md", ".mjs", ".ts"]);

const files = new Set(explicitFiles.map((file) => resolve(rootDir, file)));

for (const dir of scannedDirs) {
  await collectFiles(resolve(rootDir, dir), files);
}

const issues = [];
for (const file of [...files].sort()) {
  const text = await readFile(file, "utf8");
  const displayPath = relative(rootDir, file);

  if (text.includes("\r")) {
    issues.push(`${displayPath}: uses CRLF line endings`);
  }

  if (text.length > 0 && !text.endsWith("\n")) {
    issues.push(`${displayPath}: missing final newline`);
  }

  const lines = text.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].replace(/\r$/, "");
    if (/[ \t]+$/.test(line)) {
      issues.push(`${displayPath}:${index + 1}: trailing whitespace`);
    }
  }
}

if (issues.length > 0) {
  console.error("Formatting check failed:");
  for (const issue of issues) {
    console.error(`- ${issue}`);
  }
  process.exitCode = 1;
} else {
  console.log(`Formatting check passed (${files.size} files).`);
}

async function collectFiles(dir, files) {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      await collectFiles(path, files);
    } else if (entry.isFile() && scannedExtensions.has(extname(entry.name))) {
      files.add(path);
    }
  }
}
