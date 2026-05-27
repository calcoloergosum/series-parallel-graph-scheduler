import test, { after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { runInNewContext } from "node:vm";

const schedulerScriptUrl = builtScriptUrl("plan-scheduler");
const layoutScriptUrl = builtScriptUrl("sp-layout");
const graphIoScriptUrl = builtScriptUrl("graph-io");
const rendererScriptPath = fileURLToPath(builtScriptUrl("render-plan"));
const schedulerScriptPath = fileURLToPath(schedulerScriptUrl);
const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const originalSlackWebhookUrl = process.env.SLACK_WEBHOOK_URL;

// Tests must never inherit a developer's live Slack webhook. Individual Slack
// send coverage opts in with a local fake webhook server.
delete process.env.SLACK_WEBHOOK_URL;

after(() => {
  if (originalSlackWebhookUrl === undefined) {
    delete process.env.SLACK_WEBHOOK_URL;
  } else {
    process.env.SLACK_WEBHOOK_URL = originalSlackWebhookUrl;
  }
});

const {
  answerNode,
  blockNode,
  buildWorkerPrompt,
  buildVisualizerPayload,
  claimNode,
  completeNode,
  createVisualizerServer,
  decomposeNode,
  isLocalVisualizerHost,
  listWorkingNodes,
  listReadyLeafNodes,
  parseArgs,
  parseCodexArgs,
  parseChildrenArgs,
  readGraph,
  reconcileGraphStatus,
  releaseExpiredLeases,
  renewNodeLease,
  resetReachable,
  resetNode,
  resetSubtree,
  renderVisualizerHtml,
  runWorker,
  sendSlackNotification,
  startNode,
  summarizeGraph,
  visualizerHostSecurityWarning,
  withGraphLock,
  writeGraphAtomic,
  writeReportFile
} = await import(schedulerScriptUrl.href);
const { buildPlanarLayout, renderPlanarSvg } = await import(layoutScriptUrl.href);
const { defaultGraphPath } = await import(graphIoScriptUrl.href);

const execFileAsync = promisify(execFile);

function builtScriptUrl(scriptName) {
  const target = new URL(`../dist/scripts/${scriptName}.js`, import.meta.url);
  if (!existsSync(target)) {
    throw new Error(`Missing built ${scriptName} module in dist/scripts. Run npm run build before tests.`);
  }
  return target;
}

function builtBinPath(binName) {
  const binEntry = packageJson.bin?.[binName];
  assert.equal(typeof binEntry, "string", `Missing package bin entry: ${binName}`);
  const normalizedEntry = binEntry.replace(/^\.\//, "");
  const builtEntry = normalizedEntry.startsWith("dist/") ? normalizedEntry : `dist/${normalizedEntry}`;
  return fileURLToPath(new URL(`../${builtEntry}`, import.meta.url));
}

test("package npm scripts and bins target migrated build output", () => {
  for (const command of ["ready", "summary", "serve", "worker"]) {
    assert.match(packageJson.scripts[command], new RegExp(`node dist/scripts/plan-scheduler\\.js ${command}`));
  }

  assert.match(packageJson.scripts.render, /node dist\/scripts\/render-plan\.js/);
  assert.match(packageJson.scripts.test, /npm run build/);
  assert.equal(packageJson.bin["spg-scheduler"], "./dist/scripts/plan-scheduler.js");
  assert.equal(packageJson.bin["spg-render-plan"], "./dist/scripts/render-plan.js");
});

test("built shared graph IO defaults resolve to package graph path", () => {
  assert.equal(defaultGraphPath, fileURLToPath(new URL("../plan.graph.json", import.meta.url)));
});

function fixtureGraph() {
  return {
    graphVersion: 1,
    title: "Fixture Implementation Plan",
    description: "Coordinate fixture work across a series root, parallel branches, and a final gate.",
    scheduler: { leaseSeconds: 1 },
    graph: {
      root: "ROOT",
      nodes: {
        ROOT: { title: "Root", kind: "series", status: "pending", children: ["A", "P", "G"] },
        A: { title: "Bootstrap", kind: "task", status: "pending" },
        P: { title: "Parallel work", kind: "parallel", status: "pending", children: ["B", "C"] },
        B: { title: "Branch B", kind: "task", status: "pending" },
        C: { title: "Branch C", kind: "task", status: "pending" },
        G: { title: "Gate", kind: "gate", status: "pending" }
      }
    }
  };
}

async function withTempGraph(fn) {
  const dir = await mkdtemp(join(tmpdir(), "plan-scheduler-"));
  const graphPath = join(dir, "plan.graph.json");
  await writeFile(graphPath, `${JSON.stringify(fixtureGraph(), null, 2)}\n`, "utf8");
  try {
    await fn(graphPath, dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function waitFor(predicate, timeoutMs = 5000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const value = await predicate();
    if (value) {
      return value;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  throw new Error("Timed out waiting for condition");
}

async function assertCliFails(args, stderrPattern) {
  await assert.rejects(
    execFileAsync(process.execPath, [schedulerScriptPath, ...args]),
    (error) => {
      assert.match(error.stderr, stderrPattern);
      return true;
    }
  );
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function graphValidationCases() {
  return [
    {
      name: "missing graph body",
      mutate(graph) {
        delete graph.graph;
      },
      pathPattern: /\$\.graph/,
      messagePattern: /Expected graph body to be an object/
    },
    {
      name: "missing root id",
      mutate(graph) {
        delete graph.graph.root;
      },
      pathPattern: /\$\.graph\.root/,
      messagePattern: /Expected root node id string/
    },
    {
      name: "root id absent from nodes map",
      mutate(graph) {
        graph.graph.root = "MISSING_ROOT";
      },
      pathPattern: /\$\.graph\.root/,
      messagePattern: /Root node is not present in nodes: MISSING_ROOT/
    },
    {
      name: "missing nodes map",
      mutate(graph) {
        delete graph.graph.nodes;
      },
      pathPattern: /\$\.graph\.nodes/,
      messagePattern: /Expected node map object/
    },
    {
      name: "unknown child id",
      mutate(graph) {
        graph.graph.nodes.ROOT.children = ["MISSING"];
      },
      pathPattern: /\$\.graph\.nodes\.ROOT\.children/,
      messagePattern: /Unknown child node id: MISSING/
    },
    {
      name: "non-array children",
      mutate(graph) {
        graph.graph.nodes.ROOT.children = "A";
      },
      pathPattern: /\$\.graph\.nodes\.ROOT\.children/,
      messagePattern: /Expected children to be an array of node id strings/
    },
    {
      name: "children array with non-string ids",
      mutate(graph) {
        graph.graph.nodes.ROOT.children = ["A", 42];
      },
      pathPattern: /\$\.graph\.nodes\.ROOT\.children/,
      messagePattern: /Expected children to be an array of node id strings/
    }
  ];
}

function rendererDocumentFixture() {
  return {
    pageTitle: "Invalid Graph",
    intro: ["Renderer should validate first."],
    sections: []
  };
}

function runVisualizerClientScript() {
  const html = renderVisualizerHtml();
  const script = html.match(/<script>\n([\s\S]*)\n<\/script>/)?.[1];
  assert.equal(typeof script, "string");

  const elements = new Map();
  function element(id) {
    if (!elements.has(id)) {
      elements.set(id, {
        id,
        value: "",
        checked: false,
        dataset: {},
        disabled: false,
        addEventListener() {},
        closest() {
          return undefined;
        },
        querySelector() {
          return element(`${id}:query`);
        },
        get innerHTML() {
          return this._innerHTML || "";
        },
        set innerHTML(value) {
          this._innerHTML = String(value);
        },
        get textContent() {
          return this._textContent || "";
        },
        set textContent(value) {
          this._textContent = String(value);
        }
      });
    }
    return elements.get(id);
  }

  const context = {
    document: {
      addEventListener() {},
      getElementById: element,
      querySelector(selector) {
        return element(`query:${selector}`);
      }
    },
    localStorage: {
      getItem() {
        return null;
      },
      setItem() {}
    },
    EventSource: class {
      constructor() {
        this.onmessage = undefined;
        this.onerror = undefined;
      }
    },
    fetch: async () => ({
      ok: true,
      json: async () => ({
        summary: { graphVersion: 1, totalNodes: 0, counts: {} },
        graphSvg: "<svg></svg>",
        ready: [],
        working: [],
        workerManager: { defaults: {}, workers: [] }
      }),
      text: async () => ""
    })
  };

  runInNewContext(script, context);
  return { context, element };
}

function assertReadableGraphValidationOutput(output, graphPath, validationCase) {
  assert.match(output, /Invalid graph file/);
  assert.ok(output.includes(graphPath));
  assert.match(output, validationCase.pathPattern);
  assert.match(output, validationCase.messagePattern);
  assert.doesNotMatch(output, /Unknown child node referenced by graph/);
}

test("graph summary includes plan metadata", () => {
  const summary = summarizeGraph(fixtureGraph());
  assert.equal(summary.title, "Fixture Implementation Plan");
  assert.equal(summary.description, "Coordinate fixture work across a series root, parallel branches, and a final gate.");
});

test("graph IO keeps JSON files readable and newline terminated", async () => {
  await withTempGraph(async (graphPath, dir) => {
    const graph = fixtureGraph();
    graph.graphVersion = 42;

    await writeGraphAtomic(graph, graphPath);

    const content = await readFile(graphPath, "utf8");
    assert.ok(content.endsWith("\n"));
    assert.equal((await readGraph(graphPath)).graphVersion, 42);
    assert.deepEqual((await readdir(dir)).filter((entry) => entry.endsWith(".tmp")), []);
  });
});

test("readGraph rejects invalid graph files with path and validator details", async () => {
  await withTempGraph(async (graphPath) => {
    const graph = fixtureGraph();
    graph.graph.nodes.ROOT.children = ["MISSING"];
    await writeFile(graphPath, `${JSON.stringify(graph, null, 2)}\n`, "utf8");

    await assert.rejects(
      () => readGraph(graphPath),
      (error) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /Invalid graph file/);
        assert.ok(error.message.includes(graphPath));
        assert.match(error.message, /\$\.graph\.nodes\.ROOT\.children/);
        assert.match(error.message, /Unknown child node id: MISSING/);
        return true;
      }
    );
  });
});

test("readGraph reports readable validation errors for malformed graph shapes", async (t) => {
  for (const validationCase of graphValidationCases()) {
    await t.test(validationCase.name, async () => {
      await withTempGraph(async (graphPath) => {
        const graph = fixtureGraph();
        validationCase.mutate(graph);
        await writeFile(graphPath, `${JSON.stringify(graph, null, 2)}\n`, "utf8");

        await assert.rejects(
          () => readGraph(graphPath),
          (error) => {
            assert.ok(error instanceof Error);
            assertReadableGraphValidationOutput(error.message, graphPath, validationCase);
            assert.doesNotMatch(error.message, /\n\s+at /);
            return true;
          }
        );
      });
    });
  }
});

test("graph lock removes stale lock directories", async () => {
  await withTempGraph(async (graphPath, dir) => {
    const lockPath = `${graphPath}.lock`;
    await mkdir(lockPath);
    await writeFile(
      join(lockPath, "metadata.json"),
      `${JSON.stringify({
        pid: 12345,
        createdAt: "2026-05-27T01:00:00.000Z",
        graphPath
      })}\n`,
      "utf8"
    );
    const oldTime = new Date(Date.now() - 60_000);
    await utimes(lockPath, oldTime, oldTime);

    const result = await withGraphLock(graphPath, async () => "locked", {
      staleMs: 1,
      retryMs: 1,
      timeoutMs: 500
    });

    assert.equal(result, "locked");
    assert.deepEqual((await readdir(dir)).filter((entry) => entry.endsWith(".lock")), []);
    assert.deepEqual((await readdir(dir)).filter((entry) => entry.endsWith(".tmp")), []);
  });
});

test("graph lock writes owner metadata and removes it on release", async () => {
  await withTempGraph(async (graphPath, dir) => {
    const lockPath = `${graphPath}.lock`;

    await withGraphLock(graphPath, async () => {
      const metadata = JSON.parse(await readFile(join(lockPath, "metadata.json"), "utf8"));
      assert.equal(metadata.pid, process.pid);
      assert.equal(metadata.graphPath, graphPath);
      assert.match(metadata.createdAt, /^\d{4}-\d{2}-\d{2}T/);
      if ("host" in metadata) {
        assert.equal(typeof metadata.host, "string");
      }
    });

    assert.deepEqual((await readdir(dir)).filter((entry) => entry.endsWith(".lock")), []);
  });
});

test("graph lock timeout reports lock owner metadata", async () => {
  await withTempGraph(async (graphPath) => {
    const lockPath = `${graphPath}.lock`;
    await mkdir(lockPath);
    await writeFile(
      join(lockPath, "metadata.json"),
      `${JSON.stringify({
        pid: 67890,
        createdAt: "2026-05-27T01:23:45.000Z",
        graphPath,
        host: "test-host"
      })}\n`,
      "utf8"
    );

    const startedAt = Date.now();
    await assert.rejects(
      withGraphLock(graphPath, async () => "locked", {
        staleMs: 60_000,
        retryMs: 1,
        timeoutMs: 20
      }),
      (error) => {
        assert.match(error.message, /Timed out waiting for graph lock/);
        assert.match(error.message, new RegExp(escapeRegExp(lockPath)));
        assert.match(error.message, /owner pid=67890/);
        assert.match(error.message, /createdAt=2026-05-27T01:23:45\.000Z/);
        assert.match(error.message, /host=test-host/);
        assert.match(error.message, new RegExp(escapeRegExp(graphPath)));
        return true;
      }
    );
    assert.ok(Date.now() - startedAt < 1000, `Lock timeout for ${lockPath} should stay bounded`);
  });
});

test("report paths are constrained to the graph directory", async () => {
  await withTempGraph(async (graphPath, dir) => {
    const reportPath = await writeReportFile(graphPath, "reports/safe.md", "safe report");
    assert.equal(await readFile(reportPath, "utf8"), "safe report\n");

    await assert.rejects(
      writeReportFile(graphPath, "../escape.md", "escaped report"),
      /Path escapes graph directory/
    );
    assert.deepEqual((await readdir(dir)).sort(), ["plan.graph.json", "reports"]);
  });
});

test("series-parallel readiness exposes only legal leaf nodes", async () => {
  await withTempGraph(async (graphPath) => {
    let graph = await readGraph(graphPath);
    assert.deepEqual(listReadyLeafNodes(graph).map((node) => node.id), ["A"]);

    await claimNode(graphPath, { session: "codex-A", nodeId: "A" });
    await completeNode(graphPath, { nodeId: "A", session: "codex-A" });
    graph = await readGraph(graphPath);
    assert.deepEqual(listReadyLeafNodes(graph).map((node) => node.id).sort(), ["B", "C"]);

    await claimNode(graphPath, { session: "codex-B", nodeId: "B" });
    await completeNode(graphPath, { nodeId: "B", session: "codex-B" });
    graph = await readGraph(graphPath);
    assert.deepEqual(listReadyLeafNodes(graph).map((node) => node.id), ["C"]);

    await claimNode(graphPath, { session: "codex-C", nodeId: "C" });
    await completeNode(graphPath, { nodeId: "C", session: "codex-C" });
    graph = await readGraph(graphPath);
    assert.deepEqual(listReadyLeafNodes(graph).map((node) => node.id), ["G"]);
    assert.equal(graph.graph.nodes.P.status, "done");

    await claimNode(graphPath, { session: "codex-G", nodeId: "G" });
    await completeNode(graphPath, { nodeId: "G", session: "codex-G" });
    graph = await readGraph(graphPath);
    assert.equal(graph.graph.nodes.ROOT.status, "done");
  });
});

test("claim/start/done records lease and unlocks next series work", async () => {
  await withTempGraph(async (graphPath) => {
    const claim = await claimNode(graphPath, { session: "codex-A" });
    assert.equal(claim.nodeId, "A");
    assert.equal(claim.lease.session, "codex-A");

    let graph = await readGraph(graphPath);
    assert.equal(graph.graph.nodes.A.status, "claimed");
    assert.equal(listReadyLeafNodes(graph).length, 0);
    assert.deepEqual(listWorkingNodes(graph).map((node) => node.id), ["A"]);

    await startNode(graphPath, { nodeId: "A", session: "codex-A" });
    graph = await readGraph(graphPath);
    assert.equal(graph.graph.nodes.A.status, "running");
    assert.equal(listWorkingNodes(graph)[0].session, "codex-A");

    await completeNode(graphPath, { nodeId: "A", session: "codex-A", report: "reports/A.md" });
    graph = await readGraph(graphPath);
    assert.equal(graph.graph.nodes.A.status, "done");
    assert.equal(graph.graph.nodes.A.report, "reports/A.md");
    assert.deepEqual(listWorkingNodes(graph), []);
    assert.deepEqual(listReadyLeafNodes(graph).map((node) => node.id).sort(), ["B", "C"]);
  });
});

test("concurrent claim attempts never claim the same ready leaf", async () => {
  await withTempGraph(async (graphPath) => {
    await claimNode(graphPath, { session: "bootstrap", nodeId: "A" });
    await completeNode(graphPath, { nodeId: "A", session: "bootstrap" });

    const attempts = Array.from({ length: 8 }, (_, index) =>
      claimNode(graphPath, { session: `parallel-${index}` })
    );
    const results = await Promise.allSettled(attempts);
    const claimed = results
      .filter((result) => result.status === "fulfilled")
      .map((result) => result.value.nodeId)
      .sort();
    const rejected = results.filter((result) => result.status === "rejected");

    assert.deepEqual(claimed, ["B", "C"], `Unexpected concurrent claims for ${graphPath}`);
    assert.equal(new Set(claimed).size, claimed.length, `Duplicate claim detected for ${graphPath}`);
    assert.equal(rejected.length, 6, `Expected exhausted claim attempts for ${graphPath}`);
    for (const result of rejected) {
      assert.match(result.reason.message, /No ready nodes to claim/);
      assert.match(result.reason.message, new RegExp(escapeRegExp(graphPath)));
    }

    const graph = await readGraph(graphPath);
    assert.equal(graph.graph.nodes.B.status, "claimed");
    assert.equal(graph.graph.nodes.C.status, "claimed");
    assert.notEqual(graph.graph.nodes.B.lease.session, graph.graph.nodes.C.lease.session);
  });
});

test("leased nodes reject stale sessions and invalid transitions", async () => {
  await withTempGraph(async (graphPath) => {
    await assert.rejects(
      completeNode(graphPath, { nodeId: "A", session: "codex-A" }),
      /Cannot complete node from status pending/
    );

    await claimNode(graphPath, { session: "codex-A", nodeId: "A" });
    await assert.rejects(
      startNode(graphPath, { nodeId: "A", session: "codex-B" }),
      /Lease session mismatch/
    );

    await startNode(graphPath, { nodeId: "A", session: "codex-A" });
    await assert.rejects(
      completeNode(graphPath, { nodeId: "A" }),
      /session or runId is required/
    );
  });
});

test("blocked node does not halt unrelated parallel nodes", async () => {
  await withTempGraph(async (graphPath) => {
    await claimNode(graphPath, { session: "codex-A", nodeId: "A" });
    await completeNode(graphPath, { nodeId: "A", session: "codex-A" });
    await claimNode(graphPath, { session: "codex-B", nodeId: "B" });
    await blockNode(graphPath, { nodeId: "B", session: "codex-B", question: "Need operator decision" });

    const graph = await readGraph(graphPath);
    assert.equal(graph.graph.nodes.B.status, "blocked");
    assert.equal(graph.graph.nodes.B.lease.session, "codex-B");
    assert.deepEqual(listReadyLeafNodes(graph).map((node) => node.id), ["C"]);
  });
});

test("answer records operator response and makes a blocked node ready", async () => {
  await withTempGraph(async (graphPath) => {
    await claimNode(graphPath, { session: "codex-A", nodeId: "A" });
    await blockNode(graphPath, {
      nodeId: "A",
      session: "codex-A",
      question: "Which interface should this use?"
    });

    const result = await answerNode(graphPath, {
      nodeId: "A",
      answer: "Use the CLI interface first.",
      responder: "operator"
    });
    assert.equal(result.status, "pending");

    const graph = await readGraph(graphPath);
    assert.equal(graph.graph.nodes.A.status, "pending");
    assert.equal(graph.graph.nodes.A.question, "Which interface should this use?");
    assert.equal(graph.graph.nodes.A.answer, "Use the CLI interface first.");
    assert.equal(graph.graph.nodes.A.answeredBy, "operator");
    assert.equal(graph.graph.nodes.A.lease, undefined);
    assert.deepEqual(listReadyLeafNodes(graph).map((node) => node.id), ["A"]);

    const prompt = await buildWorkerPrompt(graphPath, { nodeId: "A", session: "codex-A2", runId: "run-answer" });
    assert.match(prompt, /Which interface should this use\?/);
    assert.match(prompt, /Use the CLI interface first\./);
  });
});

test("CLI answer unblocks a task and visualizer exposes the answer", async () => {
  await withTempGraph(async (graphPath) => {
    await claimNode(graphPath, { session: "codex-A", nodeId: "A" });
    await blockNode(graphPath, { nodeId: "A", session: "codex-A", question: "Proceed?" });

    const cli = await execFileAsync(process.execPath, [
      schedulerScriptPath,
      "answer",
      "--graph",
      graphPath,
      "--node",
      "A",
      "--answer",
      "Yes, continue.",
      "--responder",
      "jason"
    ]);
    const result = JSON.parse(cli.stdout);
    assert.equal(result.nodeId, "A");
    assert.equal(result.answer, "Yes, continue.");

    const payload = await buildVisualizerPayload(graphPath);
    assert.deepEqual(payload.ready.map((node) => node.id), ["A"]);
    assert.equal(payload.ready[0].question, "Proceed?");
    assert.equal(payload.ready[0].answer, "Yes, continue.");

    const html = renderVisualizerHtml();
    assert.match(html, /answer:/);
  });
});

test("CLI validates numeric arguments before dispatch", async () => {
  await withTempGraph(async (graphPath) => {
    const cli = await execFileAsync(process.execPath, [
      schedulerScriptPath,
      "claim",
      "--graph",
      graphPath,
      "--session",
      "codex-valid",
      "--lease",
      "1"
    ]);
    assert.equal(JSON.parse(cli.stdout).nodeId, "A");
  });

  await withTempGraph(async (graphPath) => {
    await assertCliFails(
      ["claim", "--graph", graphPath, "--lease", "nope"],
      /Invalid --lease: expected integer from 1 to 86400; received "nope"/
    );
    await assertCliFails(
      ["renew", "--graph", graphPath, "--node", "A", "--lease"],
      /Missing --lease value; expected integer from 1 to 86400/
    );
    await assertCliFails(
      ["worker", "--graph", graphPath, "--once", "--idle-ms", "-5"],
      /Invalid --idle-ms: expected integer from 1 to 86400000; received "-5"/
    );
    await assertCliFails(
      ["serve", "--graph", graphPath, "--port", "NaN"],
      /Invalid --port: expected integer from 0 to 65535; received "NaN"/
    );
    await assertCliFails(
      ["serve", "--graph", graphPath, "--port", "70000"],
      /Invalid --port: expected integer from 0 to 65535; received "70000"/
    );
  });
});

test("visualizer answer API answers a blocked task", async () => {
  await withTempGraph(async (graphPath) => {
    await claimNode(graphPath, { session: "codex-A", nodeId: "A" });
    await blockNode(graphPath, { nodeId: "A", session: "codex-A", question: "Use cache?" });

    const visualizer = await createVisualizerServer({ graphPath, port: 0 });
    try {
      const response = await fetch(`${visualizer.url}/api/answer`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ nodeId: "A", answer: "Yes, use cache.", responder: "test" })
      });
      assert.equal(response.status, 200);

      const result = await response.json();
      assert.equal(result.nodeId, "A");
      assert.equal(result.answer, "Yes, use cache.");

      const payload = await (await fetch(`${visualizer.url}/api/graph`)).json();
      assert.deepEqual(payload.ready.map((node) => node.id), ["A"]);
      assert.equal(payload.ready[0].answer, "Yes, use cache.");
    } finally {
      await visualizer.close();
    }
  });
});

test("visualizer warns when worker controls bind beyond loopback", async () => {
  assert.equal(isLocalVisualizerHost("127.0.0.1"), true);
  assert.equal(isLocalVisualizerHost("localhost"), true);
  assert.equal(isLocalVisualizerHost("::1"), true);
  assert.equal(isLocalVisualizerHost("0.0.0.0"), false);
  assert.equal(isLocalVisualizerHost("192.168.1.10"), false);
  assert.equal(visualizerHostSecurityWarning("127.0.0.1"), undefined);
  assert.match(visualizerHostSecurityWarning("0.0.0.0"), /trusted local use/);
  assert.match(visualizerHostSecurityWarning("192.168.1.10"), /worker start\/stop controls/);

  await withTempGraph(async (graphPath) => {
    const defaultVisualizer = await createVisualizerServer({ graphPath, port: 0 });
    try {
      assert.match(defaultVisualizer.url, /^http:\/\/127\.0\.0\.1:/);
      assert.equal(defaultVisualizer.securityWarning, undefined);
    } finally {
      await defaultVisualizer.close();
    }

    const visualizer = await createVisualizerServer({ graphPath, port: 0, host: "0.0.0.0" });
    try {
      assert.match(visualizer.securityWarning, /Binding to 0\.0\.0\.0/);
    } finally {
      await visualizer.close();
    }
  });
});

test("Slack notification skips cleanly when webhook is not configured", async () => {
  const previousWebhook = process.env.SLACK_WEBHOOK_URL;
  delete process.env.SLACK_WEBHOOK_URL;
  try {
    await withTempGraph(async (graphPath) => {
      assert.deepEqual(await sendSlackNotification(graphPath, "done", { nodeId: "A" }), {
        skipped: true,
        reason: "SLACK_WEBHOOK_URL is not set"
      });
    });
  } finally {
    if (previousWebhook === undefined) {
      delete process.env.SLACK_WEBHOOK_URL;
    } else {
      process.env.SLACK_WEBHOOK_URL = previousWebhook;
    }
  }
});

test("Slack notification text includes event, node, graph state, and details", async () => {
  await withTempGraph(async (graphPath) => {
    const received = [];
    const server = createServer((request, response) => {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk) => {
        body += chunk;
      });
      request.on("end", () => {
        received.push(JSON.parse(body));
        response.writeHead(200, { "content-type": "text/plain" });
        response.end("ok");
      });
    });

    await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
    const previousWebhook = process.env.SLACK_WEBHOOK_URL;
    try {
      const { port } = server.address();
      process.env.SLACK_WEBHOOK_URL = `http://127.0.0.1:${port}/slack`;
      assert.deepEqual(await sendSlackNotification(graphPath, "failed", {
        nodeId: "A",
        question: "Proceed?",
        answer: "Use CLI.",
        reason: "codex exited with 1",
        report: "reports/A.md"
      }), { sent: true });
    } finally {
      if (previousWebhook === undefined) {
        delete process.env.SLACK_WEBHOOK_URL;
      } else {
        process.env.SLACK_WEBHOOK_URL = previousWebhook;
      }
      await new Promise((resolveClose, rejectClose) => {
        server.close((error) => error ? rejectClose(error) : resolveClose());
      });
    }

    assert.equal(received.length, 1);
    assert.match(received[0].text, /\*FAILED\* A - Bootstrap/);
    assert.match(received[0].text, /graph v1; pending=6/);
    assert.match(received[0].text, /question: Proceed\?/);
    assert.match(received[0].text, /answer: Use CLI\./);
    assert.match(received[0].text, /reason: codex exited with 1/);
    assert.match(received[0].text, /report: reports\/A\.md/);
  });
});

test("CLI notification hooks return skipped Slack results without a webhook", async () => {
  const env = { ...process.env, SLACK_WEBHOOK_URL: "" };
  const cases = [
    {
      command: "done",
      prepare: async (graphPath) => claimNode(graphPath, { session: "codex-A", nodeId: "A" }),
      args: ["done", "--node", "A", "--session", "codex-A", "--report", "reports/A.md"]
    },
    {
      command: "block",
      prepare: async (graphPath) => claimNode(graphPath, { session: "codex-A", nodeId: "A" }),
      args: ["block", "--node", "A", "--session", "codex-A", "--question", "Need operator decision"]
    },
    {
      command: "answer",
      prepare: async (graphPath) => {
        await claimNode(graphPath, { session: "codex-A", nodeId: "A" });
        await blockNode(graphPath, { nodeId: "A", session: "codex-A", question: "Proceed?" });
      },
      args: ["answer", "--node", "A", "--answer", "Continue.", "--responder", "test"]
    },
    {
      command: "fail",
      prepare: async (graphPath) => claimNode(graphPath, { session: "codex-A", nodeId: "A" }),
      args: ["fail", "--node", "A", "--session", "codex-A", "--reason", "failed check", "--report", "reports/A.md"]
    },
    {
      command: "decompose",
      prepare: async (graphPath) => claimNode(graphPath, { session: "codex-A", nodeId: "A" }),
      args: ["decompose", "--node", "A", "--session", "codex-A", "--kind", "series", "--child", "A1=First", "--child", "A2=Second"]
    }
  ];

  for (const item of cases) {
    await withTempGraph(async (graphPath) => {
      await item.prepare(graphPath);
      const cli = await execFileAsync(process.execPath, [
        schedulerScriptPath,
        item.args[0],
        "--graph",
        graphPath,
        ...item.args.slice(1)
      ], { env });
      const result = JSON.parse(cli.stdout);
      assert.equal(result.slack.skipped, true, `${item.command} should skip Slack without webhook`);
      assert.equal(result.slack.reason, "SLACK_WEBHOOK_URL is not set");
    });
  }
});

test("visualizer worker API starts managed workers from shared settings", async () => {
  await withTempGraph(async (graphPath, dir) => {
    const fakeRunnerPath = join(dir, "fake-managed-runner.mjs");
    await writeFile(fakeRunnerPath, "console.log('managed worker saw ' + (process.argv.at(-1).includes('Node: A') ? 'A' : 'unknown'));\n", "utf8");

    const visualizer = await createVisualizerServer({ graphPath, port: 0, defaultWorkerCwd: dir });
    try {
      const startResponse = await fetch(`${visualizer.url}/api/workers/start`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          count: 2,
          sessionPrefix: "ui",
          cwd: dir,
          once: true,
          codexCommand: process.execPath,
          codexArgs: [fakeRunnerPath]
        })
      });
      assert.equal(startResponse.status, 200);
      const started = await startResponse.json();
      assert.equal(started.started.length, 2);
      assert.deepEqual(started.started.map((worker) => worker.session), ["ui-01", "ui-02"]);

      const manager = await waitFor(async () => {
        const payload = await (await fetch(`${visualizer.url}/api/graph`)).json();
        return payload.workerManager.workers.length === 2 && payload.workerManager.workers.every((worker) => worker.status === "exited")
          ? payload.workerManager
          : undefined;
      });
      assert.equal(manager.defaults.cwd, dir);
      assert.ok(manager.workers.some((worker) => worker.logTail.some((entry) => entry.text.includes("managed worker saw A"))));

      const graph = await readGraph(graphPath);
      assert.equal(graph.graph.nodes.A.status, "done");
    } finally {
      await visualizer.close();
    }
  });
});

test("visualizer worker API rejects invalid numeric worker settings", async () => {
  await withTempGraph(async (graphPath, dir) => {
    const visualizer = await createVisualizerServer({ graphPath, port: 0, defaultWorkerCwd: dir });
    try {
      const cases = [
        {
          body: { count: "NaN", idleMs: "5000" },
          pattern: /Invalid --count: expected integer from 1 to 100; received "NaN"/
        },
        {
          body: { count: 101 },
          pattern: /Invalid --count: expected integer from 1 to 100; received 101/
        },
        {
          body: { count: { nested: true } },
          pattern: /Invalid --count: expected number or numeric string/
        },
        {
          body: { idleMs: 86_400_001 },
          pattern: /Invalid --idle-ms: expected integer from 1 to 86400000; received 86400001/
        },
        {
          body: { leaseSeconds: 0 },
          pattern: /Invalid --lease: expected integer from 1 to 86400; received 0/
        }
      ];

      for (const item of cases) {
        const response = await fetch(`${visualizer.url}/api/workers/start`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(item.body)
        });
        assert.equal(response.status, 400);
        assert.match(await response.text(), item.pattern);

        const manager = await (await fetch(`${visualizer.url}/api/workers`)).json();
        assert.equal(manager.workers.length, 0);
      }
    } finally {
      await visualizer.close();
    }
  });
});

test("visualizer worker API rejects oversized or malformed worker command fields", async () => {
  await withTempGraph(async (graphPath, dir) => {
    const visualizer = await createVisualizerServer({ graphPath, port: 0, defaultWorkerCwd: dir });
    try {
      const longPath = "x".repeat(4097);
      const longArgs = Array.from({ length: 65 }, () => "arg");
      const cases = [
        {
          body: { cwd: longPath },
          pattern: /Invalid cwd: expected string length <= 4096/
        },
        {
          body: { cwd: ["not", "a", "path"] },
          pattern: /Invalid cwd: expected string/
        },
        {
          body: { codexCommand: "" },
          pattern: /Invalid codexCommand: expected non-empty string/
        },
        {
          body: { codexArgs: "--model=gpt-5" },
          pattern: /Invalid codexArgs: expected string array/
        },
        {
          body: { codexArgs: longArgs },
          pattern: /Invalid codexArgs: expected at most 64 entries/
        },
        {
          body: { codexArgs: ["x".repeat(4097)] },
          pattern: /Invalid codexArgs\[0\]: expected string length <= 4096/
        },
        {
          body: { codexArgs: [false] },
          pattern: /Invalid codexArgs\[0\]: expected string/
        },
        {
          body: { count: 2, codexArgs: [false] },
          pattern: /Invalid codexArgs\[0\]: expected string/
        }
      ];

      for (const item of cases) {
        const response = await fetch(`${visualizer.url}/api/workers/start`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(item.body)
        });
        assert.equal(response.status, 400);
        assert.match(await response.text(), item.pattern);

        const manager = await (await fetch(`${visualizer.url}/api/workers`)).json();
        assert.equal(manager.workers.length, 0);
      }
    } finally {
      await visualizer.close();
    }
  });
});

test("visualizer worker API stops daemon workers", async () => {
  await withTempGraph(async (graphPath, dir) => {
    const graph = fixtureGraph();
    for (const node of Object.values(graph.graph.nodes)) {
      node.status = "done";
    }
    await writeFile(graphPath, `${JSON.stringify(graph, null, 2)}\n`, "utf8");

    const visualizer = await createVisualizerServer({ graphPath, port: 0, defaultWorkerCwd: dir });
    try {
      await fetch(`${visualizer.url}/api/workers/start`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          count: 1,
          sessionPrefix: "daemon",
          cwd: dir,
          quiet: true,
          idleMs: 1000,
          codexCommand: process.execPath,
          codexArgs: ["-e", "console.log('unused')"]
        })
      });
      let manager = await (await fetch(`${visualizer.url}/api/workers`)).json();
      assert.equal(manager.workers.length, 1);
      assert.equal(manager.workers[0].status, "running");

      const stopResponse = await fetch(`${visualizer.url}/api/workers/stop-all`, { method: "POST" });
      assert.equal(stopResponse.status, 200);

      manager = await waitFor(async () => {
        const payload = await (await fetch(`${visualizer.url}/api/workers`)).json();
        return payload.workers[0]?.status === "exited" ? payload : undefined;
      });
      assert.equal(manager.workers[0].signal, "SIGTERM");
    } finally {
      await visualizer.close();
    }
  });
});

test("expired leases are released back to pending", async () => {
  await withTempGraph(async (graphPath) => {
    await claimNode(graphPath, { session: "codex-A", leaseSeconds: 1 });
    const result = await releaseExpiredLeases(graphPath, new Date(Date.now() + 2000));
    assert.deepEqual(result.released, ["A"]);

    const graph = await readGraph(graphPath);
    assert.equal(graph.graph.nodes.A.status, "pending");
    assert.deepEqual(listReadyLeafNodes(graph).map((node) => node.id), ["A"]);
  });
});

test("claim reaps expired worker leases before selecting ready work", async () => {
  await withTempGraph(async (graphPath) => {
    await claimNode(graphPath, { session: "dead-worker", nodeId: "A", leaseSeconds: 1 });

    const graph = await readGraph(graphPath);
    graph.graph.nodes.A.lease.expiresAt = new Date(Date.now() - 1000).toISOString();
    await writeFile(graphPath, `${JSON.stringify(graph, null, 2)}\n`, "utf8");

    const claim = await claimNode(graphPath, { session: "replacement-worker" });
    assert.equal(claim.nodeId, "A");
    assert.deepEqual(claim.releasedExpired, ["A"]);

    const reclaimed = await readGraph(graphPath);
    assert.equal(reclaimed.graph.nodes.A.status, "claimed");
    assert.equal(reclaimed.graph.nodes.A.lease.session, "replacement-worker");
    assert.ok(reclaimed.graph.nodes.A.history.some((entry) => entry.event === "lease_expired"));
  });
});

test("lease renewal prevents active workers from being released", async () => {
  await withTempGraph(async (graphPath) => {
    const claim = await claimNode(graphPath, { session: "codex-A", nodeId: "A", leaseSeconds: 1 });
    await startNode(graphPath, { nodeId: "A", session: "codex-A", runId: claim.runId });
    await renewNodeLease(graphPath, { nodeId: "A", session: "codex-A", runId: claim.runId, leaseSeconds: 5 });

    const result = await releaseExpiredLeases(graphPath, new Date(Date.now() + 2000));
    assert.deepEqual(result.released, []);

    const graph = await readGraph(graphPath);
    assert.equal(graph.graph.nodes.A.status, "running");
    assert.equal(graph.graph.nodes.A.lease.session, "codex-A");
    assert.ok(graph.graph.nodes.A.lease.renewedAt);
  });
});

test("reset clears a leaf and reopens completed ancestor subtrees", async () => {
  await withTempGraph(async (graphPath) => {
    for (const nodeId of ["A", "B", "C", "G"]) {
      await claimNode(graphPath, { session: `codex-${nodeId}`, nodeId });
      await completeNode(graphPath, { nodeId, session: `codex-${nodeId}`, report: `reports/${nodeId}.md` });
    }

    let graph = await readGraph(graphPath);
    assert.equal(graph.graph.nodes.ROOT.status, "done");
    assert.equal(graph.graph.nodes.P.status, "done");

    const result = await resetNode(graphPath, { nodeId: "B", reason: "retry branch B" });
    assert.deepEqual(result.resetAncestors, ["P", "ROOT"]);

    graph = await readGraph(graphPath);
    assert.equal(graph.graph.nodes.B.status, "pending");
    assert.equal(graph.graph.nodes.B.report, undefined);
    assert.equal(graph.graph.nodes.P.status, "pending");
    assert.equal(graph.graph.nodes.ROOT.status, "pending");
    assert.deepEqual(listReadyLeafNodes(graph).map((node) => node.id), ["B"]);
    assert.ok(graph.graph.nodes.B.history.some((entry) => entry.event === "reset" && entry.reason === "retry branch B"));
  });
});

test("CLI reset clears a leased task without the old owner session", async () => {
  await withTempGraph(async (graphPath) => {
    await claimNode(graphPath, { session: "stale-worker", nodeId: "A" });

    const cli = await execFileAsync(process.execPath, [
      schedulerScriptPath,
      "reset",
      "--graph",
      graphPath,
      "--node",
      "A",
      "--reason",
      "operator retry"
    ]);
    const result = JSON.parse(cli.stdout);
    assert.equal(result.nodeId, "A");

    const graph = await readGraph(graphPath);
    assert.equal(graph.graph.nodes.A.status, "pending");
    assert.equal(graph.graph.nodes.A.lease, undefined);
    assert.deepEqual(listReadyLeafNodes(graph).map((node) => node.id), ["A"]);
  });
});

test("reset-subtree clears a node and child descendants without reopening parents", async () => {
  await withTempGraph(async (graphPath) => {
    for (const nodeId of ["A", "B", "C", "G"]) {
      await claimNode(graphPath, { session: `codex-${nodeId}`, nodeId });
      await completeNode(graphPath, { nodeId, session: `codex-${nodeId}`, report: `reports/${nodeId}.md` });
    }

    const result = await resetSubtree(graphPath, { nodeId: "P", reason: "rerun branch" });
    assert.deepEqual(result.resetNodes, ["P", "B", "C"]);

    const graph = await readGraph(graphPath);
    assert.equal(graph.graph.nodes.ROOT.status, "done");
    assert.equal(graph.graph.nodes.P.status, "pending");
    assert.equal(graph.graph.nodes.B.status, "pending");
    assert.equal(graph.graph.nodes.C.status, "pending");
    assert.equal(graph.graph.nodes.G.status, "done");
    assert.equal(graph.graph.nodes.B.report, undefined);
    assert.deepEqual(listReadyLeafNodes(graph).map((node) => node.id).sort(), ["B", "C"]);
    assert.ok(graph.graph.nodes.P.history.some((entry) => entry.event === "reset_subtree" && entry.reason === "rerun branch"));
    assert.ok(graph.graph.nodes.B.history.some((entry) => entry.event === "reset_subtree" && entry.rootId === "P"));
  });
});

test("CLI reset-subtree clears child-reachable graph nodes", async () => {
  await withTempGraph(async (graphPath) => {
    await claimNode(graphPath, { session: "codex-A", nodeId: "A" });
    await completeNode(graphPath, { nodeId: "A", session: "codex-A" });
    await claimNode(graphPath, { session: "codex-B", nodeId: "B" });

    const cli = await execFileAsync(process.execPath, [
      schedulerScriptPath,
      "reset-subtree",
      "--graph",
      graphPath,
      "--node",
      "P",
      "--reason",
      "operator subtree retry"
    ]);
    const result = JSON.parse(cli.stdout);
    assert.deepEqual(result.resetNodes, ["P", "B", "C"]);

    const graph = await readGraph(graphPath);
    assert.equal(graph.graph.nodes.A.status, "done");
    assert.equal(graph.graph.nodes.P.status, "pending");
    assert.equal(graph.graph.nodes.B.status, "pending");
    assert.equal(graph.graph.nodes.B.lease, undefined);
    assert.equal(graph.graph.nodes.C.status, "pending");
  });
});

test("reset-reachable clears downstream series work without resetting parents", async () => {
  await withTempGraph(async (graphPath) => {
    for (const nodeId of ["A", "B", "C", "G"]) {
      await claimNode(graphPath, { session: `codex-${nodeId}`, nodeId });
      await completeNode(graphPath, { nodeId, session: `codex-${nodeId}`, report: `reports/${nodeId}.md` });
    }

    const result = await resetReachable(graphPath, { nodeId: "B", reason: "rerun from branch B" });
    assert.deepEqual(result.resetNodes, ["B", "G"]);

    const graph = await readGraph(graphPath);
    assert.equal(graph.graph.nodes.ROOT.status, "done");
    assert.equal(graph.graph.nodes.P.status, "done");
    assert.equal(graph.graph.nodes.B.status, "pending");
    assert.equal(graph.graph.nodes.C.status, "done");
    assert.equal(graph.graph.nodes.G.status, "pending");
    assert.equal(graph.graph.nodes.B.report, undefined);
    assert.ok(graph.graph.nodes.B.history.some((entry) => entry.event === "reset_reachable" && entry.reason === "rerun from branch B"));
    assert.ok(graph.graph.nodes.G.history.some((entry) => entry.event === "reset_reachable" && entry.rootId === "B"));
  });
});

test("CLI reset-reachable follows later series siblings from nested leaves", async () => {
  await withTempGraph(async (graphPath) => {
    const graph = {
      graphVersion: 1,
      title: "Nested Series",
      graph: {
        root: "ROOT",
        nodes: {
          ROOT: { title: "Root", kind: "series", status: "done", children: ["DISCOVERY", "BASELINE"] },
          DISCOVERY: { title: "Discovery", kind: "series", status: "done", children: ["TS1", "TS2", "TS3"] },
          TS1: { title: "TS1", kind: "task", status: "done", report: "reports/TS1.md" },
          TS2: { title: "TS2", kind: "task", status: "done", report: "reports/TS2.md" },
          TS3: { title: "TS3", kind: "task", status: "done", report: "reports/TS3.md" },
          BASELINE: { title: "Baseline", kind: "series", status: "done", children: ["TS4", "TS5"] },
          TS4: { title: "TS4", kind: "task", status: "done", report: "reports/TS4.md" },
          TS5: { title: "TS5", kind: "task", status: "done", report: "reports/TS5.md" }
        }
      }
    };
    await writeFile(graphPath, `${JSON.stringify(graph, null, 2)}\n`, "utf8");

    const cli = await execFileAsync(process.execPath, [
      schedulerScriptPath,
      "reset-reachable",
      "--graph",
      graphPath,
      "--node",
      "TS3",
      "--reason",
      "rerun from TS3"
    ]);
    const result = JSON.parse(cli.stdout);
    assert.deepEqual(result.resetNodes, ["TS3", "BASELINE", "TS4", "TS5"]);

    const updated = await readGraph(graphPath);
    assert.equal(updated.graph.nodes.ROOT.status, "done");
    assert.equal(updated.graph.nodes.DISCOVERY.status, "done");
    assert.equal(updated.graph.nodes.TS1.status, "done");
    assert.equal(updated.graph.nodes.TS2.status, "done");
    assert.equal(updated.graph.nodes.TS3.status, "pending");
    assert.equal(updated.graph.nodes.BASELINE.status, "pending");
    assert.equal(updated.graph.nodes.TS4.status, "pending");
    assert.equal(updated.graph.nodes.TS5.status, "pending");
    assert.equal(updated.graph.nodes.TS5.report, undefined);
  });
});

test("decompose replaces a leaf with a child subgraph", async () => {
  await withTempGraph(async (graphPath) => {
    await claimNode(graphPath, { session: "codex-A", nodeId: "A" });
    await decomposeNode(graphPath, {
      nodeId: "A",
      session: "codex-A",
      kind: "series",
      children: [
        { id: "A1", title: "First child" },
        { id: "A2", title: "Second child" }
      ]
    });

    let graph = await readGraph(graphPath);
    assert.deepEqual(graph.graph.nodes.A.children, ["A1", "A2"]);
    assert.equal(graph.graph.nodes.A.lease, undefined);
    assert.deepEqual(listReadyLeafNodes(graph).map((node) => node.id), ["A1"]);

    await claimNode(graphPath, { session: "codex-A1", nodeId: "A1" });
    await completeNode(graphPath, { nodeId: "A1", session: "codex-A1" });
    graph = await readGraph(graphPath);
    assert.deepEqual(listReadyLeafNodes(graph).map((node) => node.id), ["A2"]);
  });
});

test("CLI decompose updates a claimed leaf graph", async () => {
  await withTempGraph(async (graphPath) => {
    await execFileAsync(process.execPath, [
      schedulerScriptPath,
      "claim",
      "--graph",
      graphPath,
      "--node",
      "A",
      "--session",
      "codex-A"
    ]);
    await execFileAsync(process.execPath, [
      schedulerScriptPath,
      "decompose",
      "--graph",
      graphPath,
      "--node",
      "A",
      "--session",
      "codex-A",
      "--kind",
      "series",
      "--child",
      "A1=First CLI child",
      "--child",
      "A2=Second CLI child"
    ]);

    const graph = await readGraph(graphPath);
    assert.deepEqual(graph.graph.nodes.A.children, ["A1", "A2"]);
    assert.equal(graph.graph.nodes.A1.title, "First CLI child");
    assert.deepEqual(listReadyLeafNodes(graph).map((node) => node.id), ["A1"]);
  });
});

test("CLI decompose rejects ambiguous child definitions with actionable errors", async () => {
  await withTempGraph(async (graphPath) => {
    await assertCliFails(
      ["decompose", "--graph", graphPath, "--node", "A", "--child"],
      /Missing --child value\. Use ID=Title or ID:Title/
    );
    await assertCliFails(
      ["decompose", "--graph", graphPath, "--node", "A", "--child", "=Missing id"],
      /--child #1 id cannot be empty/
    );
    await assertCliFails(
      ["decompose", "--graph", graphPath, "--node", "A", "--child", "A1="],
      /--child #1 title cannot be empty/
    );
    await assertCliFails(
      ["decompose", "--graph", graphPath, "--node", "A", "--child", "A1=First", "--child-json", "[{\"id\":\"A2\",\"title\":\"Second\"}]"],
      /Use either --child or --child-json, not both/
    );
    await assertCliFails(
      ["decompose", "--graph", graphPath, "--node", "A", "--child-json", "not-json"],
      /Invalid --child-json JSON:/
    );
    await assertCliFails(
      ["decompose", "--graph", graphPath, "--node", "A", "--child-json", "{\"id\":\"A1\",\"title\":\"First\"}"],
      /--child-json must be a JSON array/
    );
    await assertCliFails(
      ["decompose", "--graph", graphPath, "--node", "A", "--child-json", "[{\"id\":\"\",\"title\":\"First\"}]"],
      /--child-json\[0\] id cannot be empty/
    );
    await assertCliFails(
      ["decompose", "--graph", graphPath, "--node", "A", "--child-json", "[{\"id\":\"A1\",\"title\":\"First\",\"children\":[7]}]"],
      /--child-json\[0\]\.children\[0\] must be a string/
    );
  });
});

test("CLI rejects repeated scalar flags and missing command fields", async () => {
  await withTempGraph(async (graphPath) => {
    await assertCliFails(
      ["prompt", "--graph", graphPath, "--node", "A", "--node", "B"],
      /Option --node can only be provided once/
    );
    await assertCliFails(
      ["prompt", "--graph", graphPath],
      /prompt requires --node/
    );
    await assertCliFails(
      ["answer", "--graph", graphPath, "--node", "A"],
      /answer requires --answer/
    );
    await assertCliFails(
      ["start", "--graph", graphPath, "--node", "--session", "codex-A"],
      /Missing --node value/
    );
  });
});

test("structured CLI parser keeps repeatable flags explicit", () => {
  assert.deepEqual(
    parseChildrenArgs({ child: ["A1=First", "A2:Second"] }),
    [
      { id: "A1", title: "First" },
      { id: "A2", title: "Second" }
    ]
  );
  assert.deepEqual(
    parseChildrenArgs({ "child-json": "[{\"id\":\"A1\",\"title\":\"First\",\"children\":[\"A1a\"]}]" }),
    [{ id: "A1", title: "First", children: ["A1a"] }]
  );
  assert.throws(
    () => parseArgs(["worker", "--once", "false"]),
    /Boolean flag --once does not accept a value; received "false"/
  );
  assert.throws(
    () => parseArgs(["worker", "--quiet=false"]),
    /Boolean flag --quiet does not accept a value; received "false"/
  );
});

test("prompt command renders an external template", async () => {
  await withTempGraph(async (graphPath, dir) => {
    const templatePath = join(dir, "task-template.md");
    await writeFile(
      templatePath,
      "Session={{session}} Node={{nodeId}} Title={{nodeTitle}} Plan={{planTitle}} Description={{planDescription}} Report={{reportPath}}\n",
      "utf8"
    );

    const prompt = await buildWorkerPrompt(graphPath, {
      nodeId: "A",
      session: "codex-A",
      runId: "run-test",
      templatePath,
      reportPath: "reports/A.md"
    });
    assert.match(prompt, /Session=codex-A/);
    assert.match(prompt, /Node=A/);
    assert.match(prompt, /Title=Bootstrap/);
    assert.match(prompt, /Plan=Fixture Implementation Plan/);
    assert.match(prompt, /Description=Coordinate fixture work across a series root, parallel branches, and a final gate\./);
    assert.match(prompt, /Report=reports\/A.md/);

    const { stdout } = await execFileAsync(process.execPath, [
      schedulerScriptPath,
      "prompt",
      "--graph",
      graphPath,
      "--node",
      "A",
      "--session",
      "codex-A",
      "--run",
      "run-test",
      "--template",
      templatePath,
      "--report",
      "reports/A.md"
    ]);
    assert.match(stdout, /Session=codex-A Node=A Title=Bootstrap Plan=Fixture Implementation Plan/);
    assert.match(stdout, /Description=Coordinate fixture work across a series root, parallel branches, and a final gate\. Report=reports\/A.md/);
  });
});

test("one-shot worker claims, runs command, writes report, and completes", async () => {
  await withTempGraph(async (graphPath, dir) => {
    const fakeRunnerPath = join(dir, "fake-codex-runner.mjs");
    await writeFile(
      fakeRunnerPath,
      "const prompt = process.argv.at(-1); console.log('fake codex completed'); console.log(prompt.includes('Node: A') ? 'saw node A' : 'missing node');\n",
      "utf8"
    );

    const result = await runWorker(graphPath, {
      session: "codex-worker-A",
      once: true,
      cwd: dir,
      stream: false,
      codexCommand: process.execPath,
      codexArgs: [fakeRunnerPath]
    });

    assert.equal(result.idle, false);
    assert.equal(result.results[0].nodeId, "A");
    assert.equal(result.results[0].status, "done");

    const graph = await readGraph(graphPath);
    assert.equal(graph.graph.nodes.A.status, "done");
    assert.match(graph.graph.nodes.A.report, /^reports\/A-run_/);

    const report = await readFile(join(dir, graph.graph.nodes.A.report), "utf8");
    assert.match(report, /fake codex completed/);
    assert.match(report, /saw node A/);
  });
});

test("CLI worker streams child output by default and supports quiet mode", async () => {
  await withTempGraph(async (graphPath, dir) => {
    const fakeRunnerPath = join(dir, "fake-stream-runner.mjs");
    await writeFile(fakeRunnerPath, "console.log('stream visible'); console.error('stream error');\n", "utf8");

    const loud = await execFileAsync(process.execPath, [
      schedulerScriptPath,
      "worker",
      "--graph",
      graphPath,
      "--session",
      "codex-stream-A",
      "--once",
      "--cwd",
      dir,
      "--codex-command",
      process.execPath,
      "--codex-arg",
      fakeRunnerPath
    ]);
    assert.match(loud.stdout, /\[codex-stream-A:A\] stream visible/);
    assert.match(loud.stderr, /\[codex-stream-A:A\] stream error/);

    const graph = await readGraph(graphPath);
    graph.graph.nodes.A.status = "pending";
    delete graph.graph.nodes.A.report;
    graph.graph.nodes.P.status = "pending";
    graph.graph.nodes.ROOT.status = "pending";
    await writeFile(graphPath, `${JSON.stringify(graph, null, 2)}\n`, "utf8");

    const quiet = await execFileAsync(process.execPath, [
      schedulerScriptPath,
      "worker",
      "--graph",
      graphPath,
      "--session",
      "codex-stream-B",
      "--once",
      "--quiet",
      "--cwd",
      dir,
      "--codex-command",
      process.execPath,
      "--codex-arg",
      fakeRunnerPath
    ]);
    assert.doesNotMatch(quiet.stdout, /stream visible/);
    assert.doesNotMatch(quiet.stderr, /stream error/);
  });
});

test("CLI worker accepts --codex-arg=value syntax", async () => {
  await withTempGraph(async (graphPath, dir) => {
    const fakeRunnerPath = join(dir, "fake-equals-runner.mjs");
    await writeFile(
      fakeRunnerPath,
      "console.log('runner args ' + JSON.stringify(process.argv.slice(2, -1))); console.log(process.argv.at(-1).includes('Node: A') ? 'saw node A' : 'missing node');\n",
      "utf8"
    );

    const result = await execFileAsync(process.execPath, [
      schedulerScriptPath,
      "worker",
      "--graph",
      graphPath,
      "--session=codex-equals-A",
      "--once",
      "--cwd",
      dir,
      "--codex-command",
      process.execPath,
      `--codex-arg=${fakeRunnerPath}`,
      "--codex-arg=--mode=fast"
    ]);

    assert.match(result.stdout, /runner args \["--mode=fast"\]/);
    assert.match(result.stdout, /saw node A/);
  });
});

test("default codex worker flags are passed through codex exec", () => {
  assert.deepEqual(
    parseCodexArgs({ "codex-arg": "--dangerously-bypass-approvals-and-sandbox" }),
    ["exec", "--dangerously-bypass-approvals-and-sandbox"]
  );
  assert.deepEqual(
    parseCodexArgs({ "codex-arg": ["exec", "--model=gpt-5"] }),
    ["exec", "--model=gpt-5"]
  );
  assert.deepEqual(
    parseCodexArgs({ "codex-arg": "--flag-for-custom-runner" }, "/tmp/custom-runner"),
    ["--flag-for-custom-runner"]
  );
  assert.throws(
    () => parseCodexArgs({ "codex-arg": true }),
    /Missing --codex-arg value\. Use --codex-arg=value for values that start with '-'\./
  );
});

test("visualizer builds graph payload and real-time HTML shell", async () => {
  await withTempGraph(async (graphPath) => {
    const html = renderVisualizerHtml();
    assert.match(html, /EventSource\("\/events"\)/);
    assert.match(html, /Ready Leaf Nodes/);
    assert.match(html, /Active Sessions/);
    assert.match(html, /Worker Manager/);
    assert.match(html, /\/api\/workers\/start/);
    assert.match(html, /id="graph"/);

    await claimNode(graphPath, { session: "codex-A", nodeId: "A" });
    const payload = await buildVisualizerPayload(graphPath);
    assert.equal(payload.summary.totalNodes, 6);
    assert.deepEqual(payload.ready.map((node) => node.id), []);
    assert.deepEqual(payload.working.map((node) => node.id), ["A"]);
    assert.equal(payload.working[0].session, "codex-A");
    assert.deepEqual(payload.workerManager.workers, []);
    assert.match(payload.graphSvg, /<svg class="sp-graph"/);
  });
});

test("visualizer browser renderers escape graph text and worker logs", () => {
  const { context, element } = runVisualizerClientScript();

  context.render({
    summary: {
      graphVersion: "1<script>alert(1)</script>",
      totalNodes: "6<img src=x onerror=alert(1)>",
      counts: { "ready\"><img src=x onerror=alert(1)>": 1 }
    },
    graphSvg: '<svg class="sp-graph"><text>&lt;script&gt;label&lt;/script&gt;</text></svg>',
    ready: [
      {
        id: 'A" onclick="alert(1)',
        title: "<img src=x onerror=alert(1)>",
        question: "<script>question()</script>",
        answer: "<b>answer</b>"
      }
    ],
    working: [
      {
        id: 'B" onclick="alert(1)',
        title: "<script>work()</script>",
        status: 'blocked" onmouseover="alert(1)',
        session: "<img src=x onerror=alert(1)>",
        runId: "<script>run()</script>",
        expiresAt: "<script>expiry()</script>",
        question: "<script>question()</script>",
        answer: "<script>answer()</script>",
        report: "<script>report()</script>"
      }
    ],
    workerManager: {
      defaults: { cwd: "", sessionPrefix: "codex", codexCommand: "codex" },
      workers: [
        {
          id: 'worker-1" onclick="alert(1)',
          session: "<img src=x onerror=alert(1)>",
          status: "running",
          pid: "<script>pid()</script>",
          cwd: "<script>cwd()</script>",
          logTail: [{ text: "<script>alert(1)</script><img src=x onerror=alert(1)>" }]
        }
      ]
    }
  });

  assert.equal(element("graph").innerHTML, '<svg class="sp-graph"><text>&lt;script&gt;label&lt;/script&gt;</text></svg>');
  const renderedHtml = ["summary", "ready", "working", "workers"]
    .map((id) => element(id).innerHTML)
    .join("\n");

  assert.match(renderedHtml, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(renderedHtml, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.doesNotMatch(renderedHtml, /<script\b/);
  assert.doesNotMatch(renderedHtml, /<img\b/);
});

test("planar layout places series before parallel branches before final gate", () => {
  const graph = fixtureGraph();
  const layout = buildPlanarLayout(graph);
  const boxes = Object.fromEntries(layout.boxes.map((box) => [box.id, box]));

  assert.ok(boxes.A.x < boxes.B.x);
  assert.ok(boxes.B.x < boxes.G.x);
  assert.ok(boxes.C.x < boxes.G.x);
  assert.notEqual(boxes.B.y, boxes.C.y);
  assert.equal(layout.boxes.length, 4);
  assert.ok(layout.frames.some((frame) => frame.id === "P" && frame.kind === "parallel"));
});

test("planar layout emits only axis-aligned connector segments", () => {
  const layout = buildPlanarLayout(fixtureGraph());

  for (const edge of layout.edges) {
    assert.ok(edge.points.length >= 2);
    for (let index = 1; index < edge.points.length; index += 1) {
      const previous = edge.points[index - 1];
      const current = edge.points[index];
      assert.ok(
        previous.x === current.x || previous.y === current.y,
        `expected axis-aligned ${edge.kind} edge: ${JSON.stringify(edge.points)}`
      );
    }
  }
});

test("planar SVG escapes node labels", () => {
  const graph = fixtureGraph();
  graph.title = "Escaping";
  graph.graph.nodes.B.title = "<script>alert(1)</script>";

  const svg = renderPlanarSvg(graph);
  assert.match(svg, /&lt;script&gt;/);
  assert.doesNotMatch(svg, /<script>/);
});

test("static renderer escapes graph document HTML fields", async () => {
  const dir = await mkdtemp(join(tmpdir(), "plan-render-"));
  const inputPath = join(dir, "plan.graph.json");
  const outputPath = join(dir, "plan.html");
  const graph = fixtureGraph();
  graph.title = "Unsafe <Title>";
  graph.document = {
    pageTitle: "Unsafe <script>title()</script>",
    nav: [
      { label: "Docs <img src=x onerror=alert(1)>", href: "javascript:alert(1)" },
      { label: "Safe", href: "README.md?x=<script>bad()</script>" }
    ],
    meta: [{ label: "Owner <script>bad()</script>", value: "Team <img src=x onerror=alert(1)>" }],
    intro: ["Intro <img src=x onerror=alert(1)>"],
    notation: {
      heading: "Notation <script>bad()</script>",
      columns: ["A <script>bad()</script>", "B"],
      rows: [["<code>S(a)</code>", "<script>alert(1)</script>"]]
    },
    sections: [
      {
        heading: "Section <script>bad()</script>",
        paragraphs: ["Paragraph <script>bad()</script>"],
        flow: "A < B"
      }
    ],
    gates: { heading: "Gates", columns: ["Gate"], rows: [["<script>bad()</script>"]] },
    callouts: [
      {
        type: 'note" onclick="bad',
        strong: "Strong <script>bad()</script>",
        bodyHtml: "Safe <code>inline</code> but not <script>bad()</script>"
      }
    ]
  };
  await writeFile(inputPath, `${JSON.stringify(graph, null, 2)}\n`, "utf8");

  try {
    await execFileAsync(process.execPath, [rendererScriptPath, inputPath, outputPath]);
    const html = await readFile(outputPath, "utf8");
    assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
    assert.match(html, /<a href="#">Docs &lt;img src=x onerror=alert\(1\)&gt;<\/a>/);
    assert.match(html, /<a href="README.md\?x=&lt;script&gt;bad\(\)&lt;\/script&gt;">Safe<\/a>/);
    assert.match(html, /<code>S\(a\)<\/code>/);
    assert.match(html, /Safe <code>inline<\/code> but not &lt;script&gt;bad\(\)&lt;\/script&gt;/);
    assert.match(html, /Strong &lt;script&gt;bad\(\)&lt;\/script&gt;/);
    assert.doesNotMatch(html, /javascript:alert/);
    assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/);
    assert.doesNotMatch(html, /<img src=x/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("CLI commands accept graph path through --graph and PLAN_GRAPH", async () => {
  await withTempGraph(async (graphPath) => {
    const byFlag = await execFileAsync(process.execPath, [schedulerScriptPath, "ready", "--graph", graphPath]);
    assert.deepEqual(JSON.parse(byFlag.stdout).map((node) => node.id), ["A"]);

    const byEnv = await execFileAsync(process.execPath, [schedulerScriptPath, "ready"], {
      env: { ...process.env, PLAN_GRAPH: graphPath }
    });
    assert.deepEqual(JSON.parse(byEnv.stdout).map((node) => node.id), ["A"]);
  });
});

test("scheduler CLI reports graph validation errors without traversing invalid graphs", async (t) => {
  for (const validationCase of graphValidationCases()) {
    await t.test(validationCase.name, async () => {
      await withTempGraph(async (graphPath) => {
        const graph = fixtureGraph();
        validationCase.mutate(graph);
        await writeFile(graphPath, `${JSON.stringify(graph, null, 2)}\n`, "utf8");

        await assert.rejects(
          () => execFileAsync(process.execPath, [schedulerScriptPath, "ready", "--graph", graphPath]),
          (error) => {
            assert.ok(error instanceof Error);
            assert.equal(error.stdout, "");
            const stderr = typeof error.stderr === "string" ? error.stderr : "";
            assertReadableGraphValidationOutput(stderr, graphPath, validationCase);
            return true;
          }
        );
      });
    });
  }
});

test("built package bin entry points smoke test scheduler and renderer CLIs", async () => {
  const schedulerBinPath = builtBinPath("spg-scheduler");
  const rendererBinPath = builtBinPath("spg-render-plan");
  const help = await execFileAsync(process.execPath, [schedulerBinPath, "help"]);
  assert.match(help.stdout, /node scripts\/plan-scheduler\.mjs ready/);

  const dir = await mkdtemp(join(tmpdir(), "plan-bin-smoke-"));
  const graphPath = join(dir, "bin.graph.json");
  const outputPath = join(dir, "bin.html");
  const graph = fixtureGraph();
  graph.document = {
    pageTitle: "Built Bin Smoke",
    intro: ["Renderer smoke"],
    sections: [{ heading: "Smoke", paragraphs: ["Built renderer CLI works."] }]
  };
  await writeFile(graphPath, `${JSON.stringify(graph, null, 2)}\n`, "utf8");

  try {
    await execFileAsync(process.execPath, [rendererBinPath, "--graph", graphPath, "--output", outputPath]);
    assert.match(await readFile(outputPath, "utf8"), /Built Bin Smoke/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("reconcile marks internal nodes done when all children are done", async () => {
  await withTempGraph(async (graphPath) => {
    const graph = await readGraph(graphPath);
    graph.graph.nodes.A.status = "done";
    graph.graph.nodes.B.status = "done";
    graph.graph.nodes.C.status = "done";
    graph.graph.nodes.G.status = "done";
    await writeFile(graphPath, `${JSON.stringify(graph, null, 2)}\n`, "utf8");

    const result = await reconcileGraphStatus(graphPath);
    assert.deepEqual(result.changed.sort(), ["P", "ROOT"]);

    const reconciled = await readGraph(graphPath);
    assert.equal(reconciled.graph.nodes.P.status, "done");
    assert.equal(reconciled.graph.nodes.ROOT.status, "done");
    assert.ok(reconciled.graph.nodes.P.history.some((entry) => entry.event === "subtree_done"));

    const cli = await execFileAsync(process.execPath, [schedulerScriptPath, "reconcile", "--graph", graphPath]);
    assert.deepEqual(JSON.parse(cli.stdout).changed, []);
  });
});

test("renderer accepts --graph and writes html next to that graph", async () => {
  const dir = await mkdtemp(join(tmpdir(), "plan-render-graph-"));
  const graphPath = join(dir, "custom.graph.json");
  const graph = fixtureGraph();
  graph.scheduler = { htmlView: "custom.html" };
  graph.document = {
    pageTitle: "Custom Graph",
    intro: ["Custom graph intro"],
    notation: { heading: "Notation", columns: ["A"], rows: [["B"]] },
    sections: [],
    gates: { heading: "Gates", columns: ["Gate"], rows: [["G"]] },
    callouts: []
  };
  await writeFile(graphPath, `${JSON.stringify(graph, null, 2)}\n`, "utf8");

  try {
    await execFileAsync(process.execPath, [rendererScriptPath, "--graph", graphPath]);
    const html = await readFile(join(dir, "custom.html"), "utf8");
    assert.match(html, /Custom Graph/);
    assert.match(html, /<svg class="sp-graph"/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("renderer CLI reports graph validation errors before layout traversal", async (t) => {
  for (const validationCase of graphValidationCases()) {
    await t.test(validationCase.name, async () => {
      const dir = await mkdtemp(join(tmpdir(), "plan-render-invalid-"));
      const graphPath = join(dir, "invalid.graph.json");
      const outputPath = join(dir, "invalid.html");
      const graph = fixtureGraph();
      graph.document = rendererDocumentFixture();
      validationCase.mutate(graph);
      await writeFile(graphPath, `${JSON.stringify(graph, null, 2)}\n`, "utf8");

      try {
        await assert.rejects(
          () => execFileAsync(process.execPath, [rendererScriptPath, "--graph", graphPath, "--output", outputPath]),
          (error) => {
            assert.ok(error instanceof Error);
            assert.equal(error.stdout, "");
            const stderr = typeof error.stderr === "string" ? error.stderr : "";
            assertReadableGraphValidationOutput(stderr, graphPath, validationCase);
            return true;
          }
        );
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  }
});

test("renderer rejects invalid graph files before layout traversal", async () => {
  const dir = await mkdtemp(join(tmpdir(), "plan-render-invalid-"));
  const graphPath = join(dir, "invalid.graph.json");
  const outputPath = join(dir, "invalid.html");
  const graph = fixtureGraph();
  graph.document = rendererDocumentFixture();
  graph.graph.nodes.ROOT.children = ["MISSING"];
  await writeFile(graphPath, `${JSON.stringify(graph, null, 2)}\n`, "utf8");

  try {
    await assert.rejects(
      () => execFileAsync(process.execPath, [rendererScriptPath, "--graph", graphPath, "--output", outputPath]),
      (error) => {
        assert.ok(error instanceof Error);
        const stderr = typeof error.stderr === "string" ? error.stderr : "";
        const output = `${error.message}\n${stderr}`;
        assert.match(output, /Invalid graph file/);
        assert.ok(output.includes(graphPath));
        assert.match(output, /\$\.graph\.nodes\.ROOT\.children/);
        assert.match(output, /Unknown child node id: MISSING/);
        assert.doesNotMatch(output, /Unknown child node referenced by graph/);
        return true;
      }
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
