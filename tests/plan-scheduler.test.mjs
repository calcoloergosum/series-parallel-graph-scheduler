import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  answerNode,
  blockNode,
  buildWorkerPrompt,
  buildVisualizerPayload,
  claimNode,
  completeNode,
  createVisualizerServer,
  decomposeNode,
  listWorkingNodes,
  listReadyLeafNodes,
  parseCodexArgs,
  readGraph,
  reconcileGraphStatus,
  releaseExpiredLeases,
  renewNodeLease,
  resetNode,
  renderVisualizerHtml,
  runWorker,
  startNode,
  summarizeGraph
} from "../scripts/plan-scheduler.mjs";
import { buildPlanarLayout, renderPlanarSvg } from "../scripts/sp-layout.mjs";

const execFileAsync = promisify(execFile);

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

test("graph summary includes plan metadata", () => {
  const summary = summarizeGraph(fixtureGraph());
  assert.equal(summary.title, "Fixture Implementation Plan");
  assert.equal(summary.description, "Coordinate fixture work across a series root, parallel branches, and a final gate.");
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
      "scripts/plan-scheduler.mjs",
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
      "scripts/plan-scheduler.mjs",
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
      "scripts/plan-scheduler.mjs",
      "claim",
      "--graph",
      graphPath,
      "--node",
      "A",
      "--session",
      "codex-A"
    ]);
    await execFileAsync(process.execPath, [
      "scripts/plan-scheduler.mjs",
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
      "scripts/plan-scheduler.mjs",
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
      "scripts/plan-scheduler.mjs",
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
      "scripts/plan-scheduler.mjs",
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
      "scripts/plan-scheduler.mjs",
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
    pageTitle: "Unsafe",
    intro: ["Intro <img src=x onerror=alert(1)>"],
    notation: {
      heading: "Notation",
      columns: ["A", "B"],
      rows: [["<code>S(a)</code>", "<script>alert(1)</script>"]]
    },
    sections: [
      {
        heading: "Section",
        paragraphs: ["Paragraph"],
        flow: "A < B"
      }
    ],
    gates: { heading: "Gates", columns: ["Gate"], rows: [["<script>bad()</script>"]] },
    callouts: [{ bodyHtml: "Safe <code>inline</code> but not <script>bad()</script>" }]
  };
  await writeFile(inputPath, `${JSON.stringify(graph, null, 2)}\n`, "utf8");

  try {
    await execFileAsync(process.execPath, ["scripts/render-plan.mjs", inputPath, outputPath]);
    const html = await readFile(outputPath, "utf8");
    assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
    assert.match(html, /<code>S\(a\)<\/code>/);
    assert.match(html, /Safe <code>inline<\/code> but not &lt;script&gt;bad\(\)&lt;\/script&gt;/);
    assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/);
    assert.doesNotMatch(html, /<img src=x/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("CLI commands accept graph path through --graph and PLAN_GRAPH", async () => {
  await withTempGraph(async (graphPath) => {
    const byFlag = await execFileAsync(process.execPath, ["scripts/plan-scheduler.mjs", "ready", "--graph", graphPath]);
    assert.deepEqual(JSON.parse(byFlag.stdout).map((node) => node.id), ["A"]);

    const byEnv = await execFileAsync(process.execPath, ["scripts/plan-scheduler.mjs", "ready"], {
      env: { ...process.env, PLAN_GRAPH: graphPath }
    });
    assert.deepEqual(JSON.parse(byEnv.stdout).map((node) => node.id), ["A"]);
  });
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

    const cli = await execFileAsync(process.execPath, ["scripts/plan-scheduler.mjs", "reconcile", "--graph", graphPath]);
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
    await execFileAsync(process.execPath, ["scripts/render-plan.mjs", "--graph", graphPath]);
    const html = await readFile(join(dir, "custom.html"), "utf8");
    assert.match(html, /Custom Graph/);
    assert.match(html, /<svg class="sp-graph"/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
