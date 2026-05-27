#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const scriptDir = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(scriptDir, "..");
const schedulerScript = resolve(rootDir, "dist/scripts/plan-scheduler.js");
const renderScript = resolve(rootDir, "dist/scripts/render-plan.js");
const smokeEnv = { ...process.env, SLACK_WEBHOOK_URL: "" };

async function main() {
  const tempRoot = await mkdtemp(join(tmpdir(), "spg-migration-smoke-"));
  try {
    await runSmokeCase({
      label: "package-cwd-relative-graph",
      cwd: rootDir,
      graphArgFor: (graphPath) => relative(rootDir, graphPath),
      tempRoot
    });

    const outsideCwd = await mkdtemp(join(tempRoot, "outside-cwd-"));
    await runSmokeCase({
      label: "outside-cwd-absolute-graph",
      cwd: outsideCwd,
      graphArgFor: (graphPath) => graphPath,
      tempRoot
    });

    console.log("migration smoke passed");
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

async function runSmokeCase({ label, cwd, graphArgFor, tempRoot }) {
  const caseDir = await mkdtemp(join(tempRoot, `${label}-`));
  const graphPath = join(caseDir, "plan.graph.json");
  const runnerPath = join(caseDir, "harmless-runner.mjs");
  const renderedPath = join(caseDir, "rendered.html");
  const graphArg = graphArgFor(graphPath);

  await writeFile(graphPath, `${JSON.stringify(smokeGraph(label), null, 2)}\n`, "utf8");
  await writeFile(runnerPath, harmlessRunnerSource(), "utf8");

  const ready = await runSchedulerJson(["ready", "--graph", graphArg], { cwd });
  assert.deepEqual(ready.map((node) => node.id), ["A"], `${label}: ready should expose A`);

  const summary = await runSchedulerJson(["summary", "--graph", graphArg], { cwd });
  assert.equal(summary.title, `Migration Smoke ${label}`);
  assert.equal(summary.counts.pending, 6);

  const prompt = await runSchedulerText([
    "prompt",
    "--graph",
    graphArg,
    "--node",
    "A",
    "--session",
    `smoke-${label}`,
    "--report",
    "reports/manual-prompt.md"
  ], { cwd });
  assert.match(prompt, /Migration Smoke Task A/);
  assert.match(prompt, /Graph file:/);

  const worker = await runSchedulerJson([
    "worker",
    "--graph",
    graphArg,
    "--session",
    `smoke-${label}`,
    "--once",
    "--quiet",
    "--codex-command",
    process.execPath,
    "--codex-arg",
    runnerPath
  ], { cwd });
  assert.equal(worker.idle, false, `${label}: worker should run a task`);
  assert.equal(worker.results[0].nodeId, "A");
  assert.equal(worker.results[0].status, "done");
  assert.equal(worker.results[0].slack.skipped, true);

  const reconciled = await runSchedulerJson(["reconcile", "--graph", graphArg], { cwd });
  assert.deepEqual(reconciled.changed, []);

  await execFileAsync(process.execPath, [
    renderScript,
    "--graph",
    graphArg,
    "--output",
    renderedPath
  ], { cwd, env: smokeEnv, timeout: 10_000 });
  const rendered = await readFile(renderedPath, "utf8");
  assert.match(rendered, /Migration Smoke/);
  assert.match(rendered, /Planar Graph View/);

  await assertServeStarts({ label, cwd, graphArg });
  console.log(`${label}: ok`);
}

async function runSchedulerJson(args, options) {
  const output = await runSchedulerText(args, options);
  return JSON.parse(output);
}

async function runSchedulerText(args, { cwd }) {
  const { stdout } = await execFileAsync(process.execPath, [schedulerScript, ...args], {
    cwd,
    env: smokeEnv,
    timeout: 15_000,
    maxBuffer: 1024 * 1024
  });
  return stdout;
}

async function assertServeStarts({ label, cwd, graphArg }) {
  const child = spawn(process.execPath, [
    schedulerScript,
    "serve",
    "--graph",
    graphArg,
    "--host",
    "127.0.0.1",
    "--port",
    "0"
  ], {
    cwd,
    env: smokeEnv,
    stdio: ["ignore", "pipe", "pipe"]
  });

  try {
    const url = await waitForServerUrl(child);
    const response = await fetch(`${url}/api/graph`);
    assert.equal(response.status, 200, `${label}: serve /api/graph should respond`);
    const payload = await response.json();
    assert.equal(payload.summary.title, `Migration Smoke ${label}`);
  } finally {
    await stopChild(child);
  }
}

async function waitForServerUrl(child) {
  let output = "";
  let settled = false;
  return new Promise((resolveUrl, rejectUrl) => {
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill("SIGTERM");
        rejectUrl(new Error(`Timed out waiting for serve startup. Output:\n${output}`));
      }
    }, 10_000);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      output += chunk;
      const match = output.match(/http:\/\/127\.0\.0\.1:\d+/);
      if (match && !settled) {
        settled = true;
        clearTimeout(timer);
        resolveUrl(match[0]);
      }
    });
    child.stderr.on("data", (chunk) => {
      output += chunk;
    });
    child.once("error", (error) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        rejectUrl(error);
      }
    });
    child.once("exit", (code, signal) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        rejectUrl(new Error(`serve exited before startup with code ${code} signal ${signal}. Output:\n${output}`));
      }
    });
  });
}

async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  await new Promise((resolveStop) => {
    child.once("exit", resolveStop);
    child.kill("SIGTERM");
  });
}

function harmlessRunnerSource() {
  return `const prompt = process.argv.at(-1) || "";
if (!prompt.includes("- Node: A") || !prompt.includes("Migration Smoke Task A")) {
  console.error("runner received an unexpected prompt");
  process.exit(2);
}
console.log("harmless migration runner completed A");
`;
}

function smokeGraph(label) {
  return {
    graphVersion: 1,
    title: `Migration Smoke ${label}`,
    description: "Temporary graph used by npm run smoke:migration.",
    scheduler: {
      leaseSeconds: 30,
      htmlView: "plan.html"
    },
    document: {
      pageTitle: `Migration Smoke ${label}`,
      nav: [],
      meta: [{ label: "Mode", value: "Smoke" }],
      intro: ["Exercises scheduler CLI parity without Slack or Codex."],
      sections: [{ heading: "Coverage", paragraphs: ["ready, summary, prompt, worker, reconcile, render, and serve startup."] }],
      callouts: []
    },
    graph: {
      root: "ROOT",
      nodes: {
        ROOT: { title: "Root", kind: "series", status: "pending", children: ["A", "P", "G"] },
        A: { title: "Migration Smoke Task A", kind: "task", status: "pending" },
        P: { title: "Parallel Smoke Branch", kind: "parallel", status: "pending", children: ["B", "C"] },
        B: { title: "Migration Smoke Task B", kind: "task", status: "pending" },
        C: { title: "Migration Smoke Task C", kind: "task", status: "pending" },
        G: { title: "Migration Smoke Gate", kind: "gate", status: "pending" }
      }
    }
  };
}

main().catch((error) => {
  console.error(error.stack || String(error));
  process.exitCode = 1;
});
