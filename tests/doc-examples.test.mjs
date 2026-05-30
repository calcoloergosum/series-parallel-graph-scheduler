import { spawn } from "node:child_process";
import test from "node:test";
import { assert, execFileAsync, fileURLToPath, join, mkdtemp, readFile, rm, schedulerScriptPath, rendererScriptPath, tmpdir, writeFile } from "./helpers/plan-scheduler-harness.mjs";

const rootDir = fileURLToPath(new URL("..", import.meta.url));
const readmePath = join(rootDir, "README.md");
const testingDocsPath = join(rootDir, "docs", "testing.md");
const commandEnv = { ...process.env, SLACK_WEBHOOK_URL: "" };

test("README quickstart read-only examples keep scheduler JSON contracts", async () => {
  const readme = await readFile(readmePath, "utf8");
  assertDocCommand(readme, "npm run summary -- --graph ./plan-scheduler-priority.graph.json");
  assertDocCommand(readme, "npm run ready -- --graph ./plan-scheduler-priority.graph.json");
  assertDocCommand(readme, "node scripts/plan-scheduler.mjs diagnostics --graph ./plan-scheduler-priority.graph.json");

  const dir = await mkdtemp(join(tmpdir(), "doc-quickstart-"));
  const graphPath = join(dir, "plan-scheduler-priority.graph.json");
  try {
    await writeFile(graphPath, await readFile(join(rootDir, "plan-scheduler-priority.graph.json"), "utf8"), "utf8");

    const summary = await runSchedulerJson(["summary", "--graph", graphPath]);
    assert.equal(summary.title, "Priority-Based Ready Task Selection Plan");
    assert.equal(summary.root, "ROOT");
    assert.equal(typeof summary.counts, "object");
    assert.equal(typeof summary.totalNodes, "number");

    const ready = await runSchedulerJson(["ready", "--graph", graphPath]);
    assert.ok(Array.isArray(ready));
    for (const node of ready) {
      assert.equal(typeof node.id, "string");
      assert.equal(typeof node.title, "string");
      assert.equal(node.status, "pending");
    }

    const diagnostics = await runSchedulerJson(["diagnostics", "--graph", graphPath]);
    assert.equal(diagnostics.summary.title, summary.title);
    assert.ok(Array.isArray(diagnostics.nextReady));
    assert.ok(Array.isArray(diagnostics.leases.active));
    assert.ok(Array.isArray(diagnostics.leases.expired));
    assert.ok(Array.isArray(diagnostics.actions));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("README disposable demo graph and lifecycle commands stay runnable", async () => {
  const readme = await readFile(readmePath, "utf8");
  assertDocCommand(readme, "node scripts/plan-scheduler.mjs claim --graph /tmp/spg-demo.graph.json --session codex-A");
  assertDocCommand(readme, "node scripts/plan-scheduler.mjs start --graph /tmp/spg-demo.graph.json --node A --session codex-A");
  assertDocCommand(readme, "SLACK_WEBHOOK_URL= node scripts/plan-scheduler.mjs done --graph /tmp/spg-demo.graph.json --node A --session codex-A --report reports/A.md --report-body \"Demo task complete.\"");
  assertDocCommand(readme, "npm run summary -- --graph /tmp/spg-demo.graph.json");

  const dir = await mkdtemp(join(tmpdir(), "doc-disposable-demo-"));
  const graphPath = join(dir, "spg-demo.graph.json");
  try {
    const demoGraph = extractDisposableDemoGraph(readme);
    await writeFile(graphPath, `${JSON.stringify(demoGraph, null, 2)}\n`, "utf8");

    const claim = await runSchedulerJson(["claim", "--graph", graphPath, "--session", "codex-A"]);
    assert.equal(claim.nodeId, "A");
    assert.equal(claim.lease.session, "codex-A");
    assert.equal(claim.summary.counts.claimed, 1);

    const start = await runSchedulerJson(["start", "--graph", graphPath, "--node", "A", "--session", "codex-A"]);
    assert.equal(start.nodeId, "A");
    assert.equal(start.status, "running");

    const done = await runSchedulerJson([
      "done",
      "--graph",
      graphPath,
      "--node",
      "A",
      "--session",
      "codex-A",
      "--report",
      "reports/A.md",
      "--report-body",
      "Demo task complete."
    ]);
    assert.equal(done.nodeId, "A");
    assert.equal(done.status, "done");
    assert.equal(done.slack.skipped, true);

    const summary = await runSchedulerJson(["summary", "--graph", graphPath]);
    assert.equal(summary.title, "Demo Plan");
    assert.equal(summary.counts.done, 2);
    assert.match(await readFile(join(dir, "reports", "A.md"), "utf8"), /Demo task complete\./);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("README renderer example writes static HTML with the documented flags", async () => {
  const readme = await readFile(readmePath, "utf8");
  assertDocCommand(readme, "npm run render -- --graph ./plan-example.graph.json --out /tmp/spg-plan-example.html");
  assertDocCommand(readme, "node scripts/render-plan.mjs --graph ./plan-example.graph.json --out /tmp/spg-plan-example.html");

  const dir = await mkdtemp(join(tmpdir(), "doc-renderer-"));
  const outputPath = join(dir, "spg-plan-example.html");
  try {
    await execFileAsync(process.execPath, [
      rendererScriptPath,
      "--graph",
      join(rootDir, "plan-example.graph.json"),
      "--out",
      outputPath
    ], { cwd: rootDir, env: commandEnv, timeout: 15_000 });
    const html = await readFile(outputPath, "utf8");
    assert.match(html, /Planar Graph View/);
    assert.match(html, /<svg\b/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("README visualizer startup example serves the graph API", async () => {
  const readme = await readFile(readmePath, "utf8");
  assertDocCommand(readme, "npm run serve -- --graph ./plan-scheduler-priority.graph.json --cwd \"$PWD\" --port 8787");
  assertDocCommand(readme, "http://127.0.0.1:8787");

  const dir = await mkdtemp(join(tmpdir(), "doc-visualizer-"));
  const graphPath = join(dir, "plan-scheduler-priority.graph.json");
  let child;
  try {
    await writeFile(graphPath, await readFile(join(rootDir, "plan-scheduler-priority.graph.json"), "utf8"), "utf8");
    child = spawn(process.execPath, [
      schedulerScriptPath,
      "serve",
      "--graph",
      graphPath,
      "--cwd",
      rootDir,
      "--port",
      "0"
    ], {
      cwd: rootDir,
      env: commandEnv,
      stdio: ["ignore", "pipe", "pipe"]
    });

    const url = await waitForVisualizerUrl(child);
    const response = await fetch(`${url}/api/graph`);
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.summary.title, "Priority-Based Ready Task Selection Plan");
    assert.match(payload.graphSvg, /<svg\b/);
  } finally {
    if (child) {
      await stopChild(child);
    }
    await rm(dir, { recursive: true, force: true });
  }
});

test("documentation example policy records reasons for examples not run in CI", async () => {
  const docs = await readFile(testingDocsPath, "utf8");
  const policy = markdownSection(docs, "Documentation Example Policy");
  assert.match(policy, /tests\/doc-examples\.test\.mjs/);

  const rows = [...policy.matchAll(/^\| `([^`]+)` \| ([^|]+) \| ([^|]+) \|$/gm)]
    .map((match) => ({
      category: match[1].trim(),
      reason: match[2].trim(),
      substitute: match[3].trim()
    }));
  assert.ok(rows.length >= 5, "policy should enumerate non-runnable example classes");
  for (const row of rows) {
    assert.notEqual(row.reason, "");
    assert.notEqual(row.substitute, "");
  }

  assertPolicyCategory(rows, "active-graph-mutation");
  assertPolicyCategory(rows, "long-running-daemon");
  assertPolicyCategory(rows, "live-codex-worker");
  assertPolicyCategory(rows, "environment-gated-release");
  assertPolicyCategory(rows, "intentional-failure");
});

async function runSchedulerJson(args) {
  const { stdout } = await execFileAsync(process.execPath, [schedulerScriptPath, ...args], {
    cwd: rootDir,
    env: commandEnv,
    timeout: 15_000,
    maxBuffer: 1024 * 1024
  });
  return JSON.parse(stdout);
}

function assertDocCommand(markdown, command) {
  assert.ok(markdown.includes(command), `README should contain documented command: ${command}`);
}

function extractDisposableDemoGraph(readme) {
  const section = markdownSection(readme, "Disposable Demo");
  const match = section.match(/cat > \/tmp\/spg-demo\.graph\.json <<'JSON'\n([\s\S]*?)\nJSON/);
  assert.ok(match, "README Disposable Demo should include a JSON here-doc");
  return JSON.parse(match[1]);
}

function markdownSection(markdown, heading) {
  const marker = `## ${heading}`;
  const start = markdown.indexOf(marker);
  assert.notEqual(start, -1, `Missing documentation section: ${heading}`);
  const next = markdown.indexOf("\n## ", start + marker.length);
  return next === -1 ? markdown.slice(start) : markdown.slice(start, next);
}

function assertPolicyCategory(rows, category) {
  assert.ok(rows.some((row) => row.category === category), `Missing policy category: ${category}`);
}

async function waitForVisualizerUrl(child) {
  let output = "";
  let settled = false;
  return new Promise((resolveUrl, rejectUrl) => {
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill("SIGTERM");
        rejectUrl(new Error(`Timed out waiting for visualizer startup. Output:\n${output}`));
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
        rejectUrl(new Error(`Visualizer exited before startup with code ${code} signal ${signal}. Output:\n${output}`));
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
