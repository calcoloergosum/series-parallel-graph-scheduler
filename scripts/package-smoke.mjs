#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, relative, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const rootDir = fileURLToPath(new URL("..", import.meta.url));
const packageJson = JSON.parse(await readFile(join(rootDir, "package.json"), "utf8"));
const packageName = packageJson.name;
const packageVersion = packageJson.version;
const requiredPackageFiles = [
  "CHANGELOG.md",
  "README.md",
  "docs/compatibility-boundaries.md",
  "docs/release-checklist.md",
  "docs/testing.md",
  "package.json",
  "plan-example.graph.json",
  "prompts/codex-worker-task.md",
  "dist/prompts/codex-worker-task.md",
  "schemas/plan-graph.schema.json",
  "scripts/plan-scheduler.mjs",
  "scripts/render-plan.mjs",
  "scripts/sp-layout.mjs",
  "dist/scripts/plan-scheduler.js",
  "dist/scripts/render-plan.js",
  "dist/scripts/worker.js",
  "dist/scripts/visualizer.js"
];
const excludedSourceFiles = [
  "scripts/plan-scheduler.ts",
  "scripts/render-plan.ts",
  "tests/package-smoke.test.mjs",
  "plan-improve.graph.json"
];
const excludedPackagePatterns = [
  { label: "TypeScript source", pattern: /^scripts\/.*\.ts$/ },
  { label: "tests", pattern: /^(tests|dist\/tests)\// },
  { label: "active improvement graphs", pattern: /^plan-improve\.graph\.json$/ },
  { label: "worker reports", pattern: /^reports\// },
  { label: "worker run directories", pattern: /^runs\// },
  { label: "logs", pattern: /^logs\// },
  { label: "temporary files", pattern: /^(tmp|temp|coverage|ci-artifacts)\// },
  { label: "rendered HTML", pattern: /(^|\/).*\.html$/ },
  { label: "graph lock directories", pattern: /(^|\/)[^/]+\.lock(?:\.reaper|\.reap\.[^/]*)?\// },
  { label: "package tarballs", pattern: /\.tgz$/ }
];
const releaseNoteCandidates = ["CHANGELOG.md", "RELEASE_NOTES.md", "docs/release-notes.md"];

const dryRun = await npmPack({ dryRun: true });
const packDir = await mkdtemp(join(tmpdir(), "spg-pack-"));
const projectDir = await mkdtemp(join(tmpdir(), "spg-install-"));

try {
  const packed = await npmPack({ packDestination: packDir });
  assert.deepEqual(
    filePaths(packed),
    filePaths(dryRun),
    "npm pack --dry-run file list differs from actual tarball file list"
  );

  verifyPackageFiles(dryRun);

  const tarballPath = join(packDir, packed.filename);
  await writeFile(join(projectDir, "package.json"), "{\"private\":true,\"type\":\"module\"}\n", "utf8");
  await run("npm", ["install", "--engine-strict=false", "--ignore-scripts", "--no-audit", "--no-fund", tarballPath], {
    cwd: projectDir
  });

  const installedPackageDir = join(projectDir, "node_modules", packageName);
  assert.deepEqual(
    await installedPackageFiles(installedPackageDir),
    filePaths(dryRun),
    "installed package file list differs from npm pack dry-run file list"
  );

  await verifyInstalledPackage(installedPackageDir);
  printReleaseEvidence({ dryRun, packed });
} finally {
  await rm(packDir, { recursive: true, force: true });
  await rm(projectDir, { recursive: true, force: true });
}

async function npmPack({ dryRun = false, packDestination } = {}) {
  const args = ["pack", "--json"];
  if (dryRun) {
    args.push("--dry-run");
  }
  if (packDestination) {
    args.push("--pack-destination", packDestination);
  }
  const { stdout } = await run("npm", args, { cwd: rootDir });
  const parsed = JSON.parse(stdout);
  assert.equal(Array.isArray(parsed), true, "npm pack --json should return an array");
  assert.equal(parsed.length, 1, "npm pack should describe exactly one package");
  return parsed[0];
}

function filePaths(packResult) {
  return packResult.files.map((file) => file.path).sort();
}

function verifyPackageFiles(packResult) {
  const paths = new Set(filePaths(packResult));
  for (const file of requiredPackageFiles) {
    assert.equal(paths.has(file), true, `Packed package is missing ${file}`);
  }
  for (const file of excludedSourceFiles) {
    assert.equal(paths.has(file), false, `Packed package should not include ${file}`);
  }
  for (const [binName, binPath] of Object.entries(packageJson.bin || {})) {
    const path = binPath.replace(/^\.\//, "");
    const packedFile = packResult.files.find((file) => file.path === path);
    assert.ok(packedFile, `Packed package is missing bin ${binName} target ${path}`);
    assert.equal((packedFile.mode & 0o111) !== 0, true, `Packed bin ${binName} target is not executable`);
  }
  const forbiddenFiles = packResult.files
    .map((file) => file.path)
    .flatMap((path) =>
      excludedPackagePatterns
        .filter(({ pattern }) => pattern.test(path))
        .map(({ label }) => `${path} (${label})`)
    );
  assert.deepEqual(forbiddenFiles, [], `Packed package includes files that should stay out of releases`);
}

async function installedPackageFiles(packageDir) {
  const files = [];
  await collectFiles(packageDir, packageDir, files);
  return files.sort();
}

async function collectFiles(root, dir, files) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      await collectFiles(root, path, files);
    } else if (entry.isFile()) {
      files.push(relative(root, path).split(sep).join("/"));
    }
  }
}

async function verifyInstalledPackage(packageDir) {
  const binDir = join(projectDir, "node_modules", ".bin");
  const schedulerBin = join(binDir, "spg-scheduler");
  const rendererBin = join(binDir, "spg-render-plan");
  await access(join(packageDir, "dist", "scripts", "plan-scheduler.js"), constants.X_OK);
  await access(join(packageDir, "dist", "scripts", "render-plan.js"), constants.X_OK);

  const help = await run(schedulerBin, ["help"], { cwd: projectDir });
  assert.match(help.stdout, /node scripts\/plan-scheduler\.mjs ready/);

  const graphPath = join(projectDir, "sample.graph.json");
  const outputPath = join(projectDir, "sample.html");
  await writeFile(graphPath, `${JSON.stringify(sampleGraph(), null, 2)}\n`, "utf8");

  const ready = await run(schedulerBin, ["ready", "--graph", graphPath], { cwd: projectDir });
  assert.deepEqual(JSON.parse(ready.stdout).map((node) => node.id), ["A"]);

  const prompt = await run(schedulerBin, ["prompt", "--graph", graphPath, "--node", "A"], { cwd: projectDir });
  assert.match(prompt.stdout, /Smoke test installed package binaries/);
  assert.match(prompt.stdout, /Scheduler command:/);

  await run(rendererBin, ["--graph", graphPath, "--output", outputPath], { cwd: projectDir });
  assert.match(await readFile(outputPath, "utf8"), /Installed Package Smoke/);

  await run(process.execPath, [join(packageDir, "scripts", "plan-scheduler.mjs"), "summary", "--graph", graphPath], { cwd: projectDir });
  const wrapperOutputPath = join(projectDir, "wrapper.html");
  await run(process.execPath, [join(packageDir, "scripts", "render-plan.mjs"), "--graph", graphPath, "--output", wrapperOutputPath], {
    cwd: projectDir
  });
  assert.match(await readFile(wrapperOutputPath, "utf8"), /Installed Package Smoke/);

  await run(process.execPath, [
    "--input-type=module",
    "--eval",
    `const module = await import(${JSON.stringify(pathToFileURL(join(packageDir, "scripts", "sp-layout.mjs")).href)}); if (typeof module.renderPlanarSvg !== "function") throw new Error("missing renderPlanarSvg");`
  ], { cwd: projectDir });

  for (const binPath of [schedulerBin, rendererBin]) {
    assert.equal((await stat(binPath)).isFile() || (await stat(binPath)).isSymbolicLink(), true, `${basename(binPath)} is not installed`);
  }
}

async function printReleaseEvidence({ dryRun, packed }) {
  const releaseNotes = await readReleaseNotesEvidence();
  const packageFiles = dryRun.files
    .map((file) => `${file.path} (${formatBytes(file.size)})`)
    .sort((left, right) => left.localeCompare(right));
  const binEvidence = Object.entries(packageJson.bin || {}).map(([binName, binPath]) => {
    const packedPath = binPath.replace(/^\.\//, "");
    const packedFile = dryRun.files.find((file) => file.path === packedPath);
    const mode = packedFile ? `0${(packedFile.mode & 0o777).toString(8)}` : "missing";
    return `${binName} -> ${packedPath} (mode ${mode}, installed smoke passed)`;
  });

  console.log(`# Release dry-run evidence`);
  console.log("");
  console.log(`Package: ${packageName}@${packageVersion}`);
  console.log(`Tarball: ${packed.filename}`);
  console.log(`Files: ${dryRun.files.length}`);
  console.log(`Unpacked size: ${formatBytes(dryRun.unpackedSize)}`);
  console.log(`Packed size: ${formatBytes(dryRun.size)}`);
  console.log("");
  console.log(`## Changelog Notes`);
  for (const line of releaseNotes) {
    console.log(`- ${line}`);
  }
  console.log("");
  console.log(`## Built Binaries`);
  for (const line of binEvidence) {
    console.log(`- ${line}`);
  }
  console.log("");
  console.log(`## Package Content Checks`);
  console.log(`- npm pack --dry-run matched the actual tarball file list.`);
  console.log(`- Installed package file list matched npm pack --dry-run.`);
  console.log(`- Required runtime files present: ${requiredPackageFiles.length}.`);
  console.log(`- Explicitly excluded files absent: ${excludedSourceFiles.length}.`);
  console.log(`- Exclusion patterns clear: ${excludedPackagePatterns.map(({ label }) => label).join(", ")}.`);
  console.log("");
  console.log(`## Package Files`);
  for (const file of packageFiles) {
    console.log(`- ${file}`);
  }
}

async function readReleaseNotesEvidence() {
  const candidatesSeen = [];
  for (const candidate of releaseNoteCandidates) {
    candidatesSeen.push(candidate);
    const path = join(rootDir, candidate);
    try {
      const contents = await readFile(path, "utf8");
      const section = extractVersionSection(contents, packageVersion);
      assert.notEqual(
        section.length,
        0,
        `${candidate} exists but has no versioned release notes for ${packageVersion}`
      );
      return [`${candidate} contains notes for ${packageVersion}: ${section.join(" ")}`];
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error;
      }
    }
  }
  assert.fail(
    `No release notes file found for ${packageVersion}; checked ${candidatesSeen.join(", ")}`
  );
}

function extractVersionSection(contents, version) {
  const lines = contents.split(/\r?\n/);
  const headingPattern = /^(#{1,3})\s+/;
  const versionPattern = new RegExp(`\\b${escapeRegExp(version)}\\b`);
  const startIndex = lines.findIndex((line) => headingPattern.test(line) && versionPattern.test(line));
  if (startIndex === -1) {
    return [];
  }
  const versionHeadingLevel = headingPattern.exec(lines[startIndex])[1].length;
  const notes = [];
  for (const line of lines.slice(startIndex + 1)) {
    const headingMatch = headingPattern.exec(line);
    if (headingMatch && headingMatch[1].length <= versionHeadingLevel) {
      break;
    }
    const trimmed = line.trim();
    if (trimmed !== "") {
      notes.push(trimmed.replace(/^#{1,3}\s+/, "").replace(/^[-*]\s+/, ""));
    }
    if (notes.length >= 5) {
      break;
    }
  }
  return notes;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function formatBytes(value) {
  assert.equal(typeof value, "number", "npm pack should report numeric file sizes");
  return `${value} bytes`;
}

function sampleGraph() {
  return {
    graphVersion: 1,
    title: "Installed Package Smoke",
    description: "Smoke test installed package binaries.",
    graph: {
      root: "ROOT",
      nodes: {
        ROOT: { title: "Root", kind: "series", status: "pending", children: ["A"] },
        A: { title: "Smoke test installed package binaries", kind: "task", status: "pending" }
      }
    },
    document: {
      pageTitle: "Installed Package Smoke",
      intro: ["Renderer verifies installed package assets."],
      sections: [{ heading: "Smoke", paragraphs: ["Installed renderer CLI works."] }]
    }
  };
}

async function run(command, args, options) {
  return execFileAsync(command, args, {
    ...options,
    maxBuffer: 10 * 1024 * 1024,
    env: {
      ...process.env,
      SLACK_WEBHOOK_URL: ""
    }
  });
}
