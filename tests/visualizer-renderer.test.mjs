import test from "node:test";
import { assert, assertInvalidFixtureFailure, blockNode, buildPlanarLayout, buildSlackNotificationText, buildVisualizerPayload, claimNode, copyGraphFixtureToTemp, createServer, createVisualizerServer, execFileAsync, existsSync, fixtureGraph, formatWorkerReport, invalidGraphValidatorOutcomes, isLocalVisualizerHost, join, mkdir, mkdtemp, readFile, readGraph, readdir, renderPlanarSvg, renderVisualizerHtml, rendererDocumentFixture, rendererScriptPath, rm, runVisualizerClientScript, schedulerScriptPath, sendSlackNotification, tmpdir, utimes, visualizerHostSecurityWarning, waitFor, withTempGraph, writeFile } from "./helpers/plan-scheduler-harness.mjs";

async function openSseJsonStream(baseUrl) {
  const controller = new AbortController();
  const response = await fetch(`${baseUrl}/events`, { signal: controller.signal });
  assert.equal(response.status, 200);
  assert.ok(response.body);

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  return {
    async nextJson() {
      while (true) {
        const separatorIndex = buffer.indexOf("\n\n");
        if (separatorIndex >= 0) {
          const rawEvent = buffer.slice(0, separatorIndex);
          buffer = buffer.slice(separatorIndex + 2);
          const data = rawEvent
            .split("\n")
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice("data:".length).trimStart())
            .join("\n");
          if (data) {
            return JSON.parse(data);
          }
          continue;
        }

        const { done, value } = await reader.read();
        if (done) {
          throw new Error("SSE stream closed before the next event");
        }
        buffer += decoder.decode(value, { stream: true });
      }
    },
    async close() {
      controller.abort();
      try {
        await reader.cancel();
      } catch {
        // The abort above may already have closed the stream.
      }
    }
  };
}

async function assertJsonResponse(response, route) {
  assert.equal(response.status, 200, route);
  assert.match(response.headers.get("content-type") ?? "", /^application\/json/, route);
  return response.json();
}

async function postJson(url, body, headers = {}) {
  return fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body)
  });
}

async function postNodeOrFail(baseUrl, route, body, headers) {
  const response = await postJson(`${baseUrl}/api/node/${route}`, body, headers);
  if (response.status !== 200) {
    assert.fail(`${route}: ${await response.text()}`);
  }
  return response.json();
}

function expectedSummary(graph) {
  const counts = {};
  for (const node of Object.values(graph.graph.nodes)) {
    const status = node.status || "pending";
    counts[status] = (counts[status] || 0) + 1;
  }
  return {
    graphVersion: graph.graphVersion,
    title: graph.title,
    description: graph.description,
    totalNodes: Object.keys(graph.graph.nodes).length,
    root: graph.graph.root,
    counts
  };
}

async function assertSummaryMatchesGraph(baseUrl, summary, graphPath) {
  const graph = await readGraph(graphPath);
  assert.deepEqual(summary, expectedSummary(graph));
  const summaryResponse = await fetch(`${baseUrl}/api/summary`);
  assert.equal(summaryResponse.status, 200);
  assert.deepEqual(await summaryResponse.json(), summary);
  return graph;
}

function latestHistory(node) {
  assert.ok(Array.isArray(node.history) && node.history.length > 0, "expected node history");
  return node.history.at(-1);
}

function assertSkippedSlack(slack) {
  assert.deepEqual(Object.keys(slack).sort(), ["reason", "skipped"]);
  assert.equal(slack.skipped, true);
  assert.match(slack.reason, /SLACK_WEBHOOK_URL/);
}

test("invalid graph fixtures fail scheduler and renderer paths before writes", async (t) => {
  for (const outcome of invalidGraphValidatorOutcomes()) {
    await t.test(outcome.fixture, async () => {
      const { dir, graphPath } = await copyGraphFixtureToTemp(outcome.fixture);
      const outputPath = join(dir, "rendered.html");
      const before = await readFile(graphPath, "utf8");
      try {
        await assert.rejects(
          () => execFileAsync(process.execPath, [
            schedulerScriptPath,
            "claim",
            "--graph",
            graphPath,
            "--session",
            "fixture-test"
          ]),
          (error) => {
            assert.equal(error.stdout, "");
            const stderr = typeof error.stderr === "string" ? error.stderr : "";
            assertInvalidFixtureFailure(stderr, graphPath, outcome);
            assert.doesNotMatch(stderr, /\n\s+at /);
            return true;
          }
        );
        assert.equal(await readFile(graphPath, "utf8"), before, "scheduler rejection should not mutate graph file");

        await assert.rejects(
          () => execFileAsync(process.execPath, [rendererScriptPath, "--graph", graphPath, "--output", outputPath]),
          (error) => {
            assert.equal(error.stdout, "");
            const stderr = typeof error.stderr === "string" ? error.stderr : "";
            assertInvalidFixtureFailure(stderr, graphPath, outcome);
            assert.doesNotMatch(stderr, /\n\s+at /);
            return true;
          }
        );
        assert.equal(await readFile(graphPath, "utf8"), before, "renderer rejection should not mutate graph file");
        assert.equal(existsSync(outputPath), false, "renderer rejection should not write output");
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  }
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

test("visualizer node mutation routes use scheduler transitions", async () => {
  await withTempGraph(async (graphPath, dir) => {
    const visualizer = await createVisualizerServer({ graphPath, port: 0 });
    try {
      const postNode = (route, body) => postNodeOrFail(visualizer.url, route, body);

      const claim = await postNode("claim", { nodeId: "A", session: "codex-api", leaseSeconds: 60 });
      assert.equal(claim.nodeId, "A");
      assert.equal(claim.lease.session, "codex-api");
      let graph = await assertSummaryMatchesGraph(visualizer.url, claim.summary, graphPath);
      assert.equal(graph.graph.nodes.A.status, "claimed");
      assert.equal(graph.graph.nodes.A.lease.runId, claim.runId);
      assert.equal(latestHistory(graph.graph.nodes.A).event, "claimed");
      assert.deepEqual(claim.summary.counts, { claimed: 1, pending: 5 });

      const start = await postNode("start", { nodeId: "A", session: "codex-api", runId: claim.runId });
      assert.equal(start.status, "running");
      graph = await assertSummaryMatchesGraph(visualizer.url, start.summary, graphPath);
      assert.equal(graph.graph.nodes.A.status, "running");
      assert.equal(graph.graph.nodes.A.startedAt, latestHistory(graph.graph.nodes.A).startedAt);
      assert.equal(latestHistory(graph.graph.nodes.A).event, "running");

      const renew = await postNode("renew", { nodeId: "A", session: "codex-api", runId: claim.runId, leaseSeconds: 120 });
      assert.equal(renew.nodeId, "A");
      assert.equal(renew.lease.session, "codex-api");
      graph = await assertSummaryMatchesGraph(visualizer.url, renew.summary, graphPath);
      assert.equal(graph.graph.nodes.A.lease.renewedAt, renew.lease.renewedAt);
      assert.equal(latestHistory(graph.graph.nodes.A).event, "renewed");

      const done = await postNode("done", {
        nodeId: "A",
        session: "codex-api",
        runId: claim.runId,
        report: "reports/A.md",
        reportBody: "completed via API"
      });
      assert.equal(done.status, "done");
      assertSkippedSlack(done.slack);
      assert.equal(await readFile(join(dir, "reports", "A.md"), "utf8"), "completed via API\n");
      graph = await assertSummaryMatchesGraph(visualizer.url, done.summary, graphPath);
      assert.equal(graph.graph.nodes.A.status, "done");
      assert.equal(graph.graph.nodes.A.report, "reports/A.md");
      assert.equal(graph.graph.nodes.A.lease, undefined);
      assert.equal(latestHistory(graph.graph.nodes.A).event, "done");

      const reset = await postNode("reset", { nodeId: "A", reason: "exercise API reset" });
      assert.equal(reset.status, "pending");
      graph = await assertSummaryMatchesGraph(visualizer.url, reset.summary, graphPath);
      assert.equal(graph.graph.nodes.A.status, "pending");
      assert.equal(graph.graph.nodes.A.report, undefined);
      assert.equal(latestHistory(graph.graph.nodes.A).event, "reset");
      assert.deepEqual(reset.resetAncestors, []);

      const blockClaim = await postNode("claim", { nodeId: "A", session: "codex-api" });
      const block = await postNode("block", {
        nodeId: "A",
        session: "codex-api",
        runId: blockClaim.runId,
        question: "Proceed?",
        reason: "needs_operator_decision"
      });
      assert.equal(block.status, "blocked");
      assertSkippedSlack(block.slack);
      graph = await assertSummaryMatchesGraph(visualizer.url, block.summary, graphPath);
      assert.equal(graph.graph.nodes.A.status, "blocked");
      assert.equal(graph.graph.nodes.A.question, "Proceed?");
      assert.equal(graph.graph.nodes.A.blockedReason, "needs_operator_decision");
      assert.equal(latestHistory(graph.graph.nodes.A).event, "blocked");

      const answer = await postNode("answer", { nodeId: "A", answer: "Proceed.", responder: "api-test" });
      assert.equal(answer.status, "pending");
      assert.equal(answer.answer, "Proceed.");
      assertSkippedSlack(answer.slack);
      graph = await assertSummaryMatchesGraph(visualizer.url, answer.summary, graphPath);
      assert.equal(graph.graph.nodes.A.status, "pending");
      assert.equal(graph.graph.nodes.A.answer, "Proceed.");
      assert.equal(graph.graph.nodes.A.answeredBy, "api-test");
      assert.equal(graph.graph.nodes.A.lease, undefined);
      assert.equal(latestHistory(graph.graph.nodes.A).event, "answered");

      const failClaim = await postNode("claim", { nodeId: "A", session: "codex-api" });
      const fail = await postNode("fail", {
        nodeId: "A",
        session: "codex-api",
        runId: failClaim.runId,
        reason: "exercise API fail",
        report: "reports/fail.md"
      });
      assert.equal(fail.status, "failed");
      assertSkippedSlack(fail.slack);
      graph = await assertSummaryMatchesGraph(visualizer.url, fail.summary, graphPath);
      assert.equal(graph.graph.nodes.A.status, "failed");
      assert.equal(graph.graph.nodes.A.failureReason, "exercise API fail");
      assert.equal(graph.graph.nodes.A.report, "reports/fail.md");
      assert.equal(graph.graph.nodes.A.lease, undefined);
      assert.equal(latestHistory(graph.graph.nodes.A).event, "failed");

      const subtreeReset = await postNode("reset-subtree", { nodeId: "ROOT", reason: "exercise API subtree reset" });
      assert.deepEqual(new Set(subtreeReset.resetNodes), new Set(["ROOT", "A", "P", "B", "C", "G"]));
      graph = await assertSummaryMatchesGraph(visualizer.url, subtreeReset.summary, graphPath);
      assert.equal(graph.graph.nodes.A.status, "pending");
      assert.equal(graph.graph.nodes.P.status, "pending");
      assert.equal(latestHistory(graph.graph.nodes.A).resetScope, "subtree");

      const decomposeClaim = await postNode("claim", { nodeId: "A", session: "codex-api" });
      const decompose = await postNode("decompose", {
        nodeId: "A",
        session: "codex-api",
        runId: decomposeClaim.runId,
        kind: "series",
        children: [
          { id: "A1", title: "API child 1", kind: "task" },
          { id: "A2", title: "API child 2", kind: "task" }
        ]
      });
      assert.deepEqual(decompose.children, ["A1", "A2"]);
      assertSkippedSlack(decompose.slack);
      graph = await assertSummaryMatchesGraph(visualizer.url, decompose.summary, graphPath);
      assert.deepEqual(graph.graph.nodes.A.children, ["A1", "A2"]);
      assert.equal(graph.graph.nodes.A.kind, "series");
      assert.equal(graph.graph.nodes.A.status, "pending");
      assert.equal(graph.graph.nodes.A.lease, undefined);
      assert.equal(graph.graph.nodes.A1.status, "pending");
      assert.equal(latestHistory(graph.graph.nodes.A).event, "decomposed");

      const reachableReset = await postNode("reset-reachable", { nodeId: "A", reason: "exercise API reachable reset" });
      assert.ok(reachableReset.resetNodes.includes("A1"));
      assert.ok(reachableReset.resetNodes.includes("P"));
      assert.ok(reachableReset.resetNodes.includes("G"));
      graph = await assertSummaryMatchesGraph(visualizer.url, reachableReset.summary, graphPath);
      assert.deepEqual(graph.graph.nodes.A.children, ["A1", "A2"]);
      assert.equal(graph.graph.nodes.A1.status, "pending");
      assert.equal(latestHistory(graph.graph.nodes.A1).resetScope, "reachable");
    } finally {
      await visualizer.close();
    }
  });
});

test("visualizer node mutation routes reject lease mismatches without mutating graph", async (t) => {
  const cases = [
    {
      route: "start",
      body: (claim) => ({ nodeId: "A", session: "wrong-session", runId: claim.runId }),
      expected: /Lease session mismatch/,
      assertUnchanged: (node) => assert.equal(node.startedAt, undefined)
    },
    {
      route: "renew",
      body: () => ({ nodeId: "A", session: "codex-api", runId: "wrong-run", leaseSeconds: 120 }),
      expected: /Lease runId mismatch/,
      assertUnchanged: (node, claim) => assert.equal(node.lease.expiresAt, claim.lease.expiresAt)
    },
    {
      route: "done",
      body: (claim) => ({ nodeId: "A", session: "wrong-session", runId: claim.runId, report: "reports/A.md" }),
      expected: /Lease session mismatch/,
      assertUnchanged: (node) => {
        assert.equal(node.completedAt, undefined);
        assert.equal(node.report, undefined);
      }
    },
    {
      route: "block",
      body: () => ({ nodeId: "A", session: "codex-api", runId: "wrong-run", question: "Proceed?" }),
      expected: /Lease runId mismatch/,
      assertUnchanged: (node) => {
        assert.equal(node.blockedAt, undefined);
        assert.equal(node.question, undefined);
      }
    },
    {
      route: "fail",
      body: (claim) => ({ nodeId: "A", session: "wrong-session", runId: claim.runId, reason: "wrong owner" }),
      expected: /Lease session mismatch/,
      assertUnchanged: (node) => {
        assert.equal(node.failedAt, undefined);
        assert.equal(node.failureReason, undefined);
      }
    }
  ];

  for (const item of cases) {
    await t.test(item.route, async () => {
      await withTempGraph(async (graphPath) => {
        const visualizer = await createVisualizerServer({ graphPath, port: 0 });
        try {
          const claim = await postNodeOrFail(visualizer.url, "claim", { nodeId: "A", session: "codex-api" });
          const before = await readGraph(graphPath);
          const response = await postJson(`${visualizer.url}/api/node/${item.route}`, item.body(claim));
          assert.equal(response.status, 500);
          assert.match(await response.text(), item.expected);

          const graph = await readGraph(graphPath);
          assert.equal(graph.graphVersion, before.graphVersion);
          assert.equal(graph.graph.nodes.A.status, "claimed");
          assert.equal(graph.graph.nodes.A.lease.session, "codex-api");
          assert.equal(graph.graph.nodes.A.lease.runId, claim.runId);
          item.assertUnchanged(graph.graph.nodes.A, claim);
          assert.deepEqual(graph.graph.nodes.A.history, before.graph.nodes.A.history);
        } finally {
          await visualizer.close();
        }
      });
    });
  }
});

test("visualizer done route rejects report body paths outside the graph directory", async () => {
  await withTempGraph(async (graphPath, dir) => {
    const visualizer = await createVisualizerServer({ graphPath, port: 0 });
    try {
      const claim = await postNodeOrFail(visualizer.url, "claim", { nodeId: "A", session: "codex-api" });
      const before = await readGraph(graphPath);
      const escapedReport = `escaped-report-${process.pid}.md`;
      const response = await postJson(`${visualizer.url}/api/node/done`, {
        nodeId: "A",
        session: "codex-api",
        runId: claim.runId,
        report: `../${escapedReport}`,
        reportBody: "should not be written"
      });
      assert.equal(response.status, 500);
      assert.match(await response.text(), /Path escapes graph directory/);
      assert.equal(existsSync(join(dir, "..", escapedReport)), false);

      const graph = await readGraph(graphPath);
      assert.equal(graph.graphVersion, before.graphVersion);
      assert.equal(graph.graph.nodes.A.status, "claimed");
      assert.equal(graph.graph.nodes.A.report, undefined);
      assert.equal(graph.graph.nodes.A.completedAt, undefined);
      assert.deepEqual(graph.graph.nodes.A.history, before.graph.nodes.A.history);
    } finally {
      await visualizer.close();
    }
  });
});

test("visualizer graph and lease operational routes refresh renderer output and broadcast SSE", async () => {
  await withTempGraph(async (graphPath, dir) => {
    const graph = fixtureGraph();
    graph.document = rendererDocumentFixture();
    for (const nodeId of ["A", "B", "C", "G"]) {
      graph.graph.nodes[nodeId].status = "done";
    }
    await writeFile(graphPath, `${JSON.stringify(graph, null, 2)}\n`, "utf8");

    const visualizer = await createVisualizerServer({ graphPath, port: 0 });
    const sse = await openSseJsonStream(visualizer.url);
    try {
      await sse.nextJson();
      const response = await fetch(`${visualizer.url}/api/graph/reconcile`, { method: "POST" });
      assert.equal(response.status, 200);

      const result = await response.json();
      assert.deepEqual(new Set(result.changed), new Set(["P", "ROOT"]));
      assert.equal(result.summary.counts.done, 6);

      const payload = await sse.nextJson();
      assert.equal(payload.graph.graph.nodes.ROOT.status, "done");
      assert.equal(payload.summary.counts.done, 6);
      assert.equal(existsSync(join(dir, "plan.html")), true);
    } finally {
      await sse.close();
      await visualizer.close();
    }
  });

  await withTempGraph(async (graphPath, dir) => {
    const graph = fixtureGraph();
    graph.document = rendererDocumentFixture();
    graph.graph.nodes.A.status = "running";
    graph.graph.nodes.A.startedAt = "2000-01-01T00:00:00.000Z";
    graph.graph.nodes.A.lease = {
      session: "codex-expired",
      runId: "run-expired",
      claimedAt: "2000-01-01T00:00:00.000Z",
      renewedAt: "2000-01-01T00:00:00.000Z",
      expiresAt: "2000-01-01T00:00:01.000Z"
    };
    await writeFile(graphPath, `${JSON.stringify(graph, null, 2)}\n`, "utf8");
    await writeFile(join(dir, "plan.html"), "stale renderer output", "utf8");

    const visualizer = await createVisualizerServer({ graphPath, port: 0 });
    const sse = await openSseJsonStream(visualizer.url);
    try {
      const initialPayload = await sse.nextJson();
      assert.deepEqual(initialPayload.working.map((node) => node.id), ["A"]);

      const response = await fetch(`${visualizer.url}/api/leases/release-expired`, { method: "POST" });
      assert.equal(response.status, 200);

      const result = await response.json();
      assert.deepEqual(result.released, ["A"]);
      assert.equal(result.summary.counts.pending, 6);

      const payload = await sse.nextJson();
      assert.deepEqual(payload.working, []);
      assert.deepEqual(payload.ready.map((node) => node.id), ["A"]);
      assert.match(await readFile(join(dir, "plan.html"), "utf8"), /Invalid Graph/);
    } finally {
      await sse.close();
      await visualizer.close();
    }
  });
});

test("visualizer warns when write routes bind beyond loopback", async () => {
  assert.equal(isLocalVisualizerHost("127.0.0.1"), true);
  assert.equal(isLocalVisualizerHost("localhost"), true);
  assert.equal(isLocalVisualizerHost("::1"), true);
  assert.equal(isLocalVisualizerHost("0.0.0.0"), false);
  assert.equal(isLocalVisualizerHost("192.168.1.10"), false);
  assert.equal(visualizerHostSecurityWarning("127.0.0.1"), undefined);
  assert.match(visualizerHostSecurityWarning("0.0.0.0"), /trusted local use/);
  assert.match(visualizerHostSecurityWarning("192.168.1.10"), /worker start\/stop controls/);
  assert.match(visualizerHostSecurityWarning("192.168.1.10"), /node mutation routes/);
  assert.match(visualizerHostSecurityWarning("192.168.1.10"), /graph-level recovery mutation routes/);
  assert.match(visualizerHostSecurityWarning("0.0.0.0", true), /unsafe visualizer writes are enabled/);
  assert.match(visualizerHostSecurityWarning("0.0.0.0", true), /mutate graph nodes/);
  assert.match(visualizerHostSecurityWarning("0.0.0.0", true), /graph-level recovery mutations/);
  assert.match(visualizerHostSecurityWarning("0.0.0.0", true), /without a token/);

  await withTempGraph(async (graphPath) => {
    const defaultVisualizer = await createVisualizerServer({ graphPath, port: 0 });
    try {
      assert.match(defaultVisualizer.url, /^http:\/\/127\.0\.0\.1:/);
      assert.equal(defaultVisualizer.securityWarning, undefined);
    } finally {
      await defaultVisualizer.close();
    }

    const visualizer = await createVisualizerServer({
      graphPath,
      port: 0,
      host: "0.0.0.0",
      allowUnsafeWrites: true
    });
    try {
      assert.match(visualizer.securityWarning, /unsafe visualizer writes are enabled on 0\.0\.0\.0/);
    } finally {
      await visualizer.close();
    }
  });
});

test("visualizer refuses unprotected non-loopback write endpoints", async () => {
  await withTempGraph(async (graphPath) => {
    await assert.rejects(
      createVisualizerServer({ graphPath, port: 0, host: "0.0.0.0" }),
      /Refusing to bind visualizer write endpoints to 0\.0\.0\.0 without protection/
    );
  });
});

test("visualizer write token protects mutation routes", async () => {
  await withTempGraph(async (graphPath, dir) => {
    await claimNode(graphPath, { session: "codex-A", nodeId: "A" });
    await blockNode(graphPath, { nodeId: "A", session: "codex-A", question: "Use cache?" });

    const visualizer = await createVisualizerServer({
      graphPath,
      port: 0,
      host: "0.0.0.0",
      writeToken: "secret-token"
    });
    const url = visualizer.url.replace("0.0.0.0", "127.0.0.1");
    try {
      const graphResponse = await fetch(`${url}/api/graph`);
      assert.equal(graphResponse.status, 200);

      const forbiddenWorkerStart = await fetch(`${url}/api/workers/start`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ count: 1 })
      });
      assert.equal(forbiddenWorkerStart.status, 403);
      assert.match(await forbiddenWorkerStart.text(), /visualizer write token/);

      const forbiddenAnswer = await fetch(`${url}/api/answer`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-spg-visualizer-token": "wrong-token" },
        body: JSON.stringify({ nodeId: "A", answer: "No" })
      });
      assert.equal(forbiddenAnswer.status, 403);

      const forbiddenNodeReset = await fetch(`${url}/api/node/reset`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ nodeId: "A" })
      });
      assert.equal(forbiddenNodeReset.status, 403);

      const forbiddenGraphReconcile = await fetch(`${url}/api/graph/reconcile`, { method: "POST" });
      assert.equal(forbiddenGraphReconcile.status, 403);

      const forbiddenReleaseExpired = await fetch(`${url}/api/leases/release-expired`, {
        method: "POST",
        headers: { "x-spg-visualizer-token": "wrong-token" }
      });
      assert.equal(forbiddenReleaseExpired.status, 403);

      const answerResponse = await fetch(`${url}/api/answer`, {
        method: "POST",
        headers: { "content-type": "application/json", "authorization": "Bearer secret-token" },
        body: JSON.stringify({ nodeId: "A", answer: "Yes, use cache.", responder: "test" })
      });
      assert.equal(answerResponse.status, 200);
      assert.equal((await answerResponse.json()).answer, "Yes, use cache.");

      const reconcileResponse = await fetch(`${url}/api/graph/reconcile`, {
        method: "POST",
        headers: { "x-spg-visualizer-token": "secret-token" }
      });
      assert.equal(reconcileResponse.status, 200);

      const claimResponse = await fetch(`${url}/api/node/claim`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-spg-visualizer-token": "secret-token" },
        body: JSON.stringify({ nodeId: "A", session: "token-test" })
      });
      assert.equal(claimResponse.status, 200);
      assert.equal((await claimResponse.json()).nodeId, "A");

      const forbiddenDone = await fetch(`${url}/api/node/done`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          nodeId: "A",
          session: "token-test",
          report: "reports/token-denied.md",
          reportBody: "denied report body"
        })
      });
      assert.equal(forbiddenDone.status, 403);
      assert.equal(existsSync(join(dir, "reports", "token-denied.md")), false);
      assert.equal((await readGraph(graphPath)).graph.nodes.A.status, "claimed");

      const resetResponse = await fetch(`${url}/api/node/reset`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-spg-visualizer-token": "secret-token" },
        body: JSON.stringify({ nodeId: "A", reason: "token-protected node mutation" })
      });
      assert.equal(resetResponse.status, 200);
      assert.equal((await resetResponse.json()).status, "pending");

      const stopAllResponse = await fetch(`${url}/api/workers/stop-all`, {
        method: "POST",
        headers: { "x-spg-visualizer-token": "secret-token" }
      });
      assert.equal(stopAllResponse.status, 200);
    } finally {
      await visualizer.close();
    }
  });
});

test("visualizer exposes read-only CLI parity routes without write token", async () => {
  await withTempGraph(async (graphPath, dir) => {
    await claimNode(graphPath, { session: "codex-A", nodeId: "A", leaseSeconds: 60 });
    const templatePath = join(dir, "preview-template.md");
    await writeFile(
      templatePath,
      "cwd={{cwd}}\nnode={{nodeId}}\nsession={{session}}\nrun={{runId}}\nreport={{reportPath}}\ntitle={{nodeTitle}}\n",
      "utf8"
    );

    const visualizer = await createVisualizerServer({
      graphPath,
      port: 0,
      host: "0.0.0.0",
      writeToken: "secret-token"
    });
    const url = visualizer.url.replace("0.0.0.0", "127.0.0.1");
    try {
      const before = await readFile(graphPath, "utf8");

      const summaryResponse = await fetch(`${url}/api/summary`);
      const summary = await assertJsonResponse(summaryResponse, "/api/summary");
      assert.equal(summary.title, "Fixture Implementation Plan");
      assert.equal(summary.totalNodes, 6);

      const readyResponse = await fetch(`${url}/api/ready`);
      const ready = await assertJsonResponse(readyResponse, "/api/ready");
      assert.deepEqual(ready.map((node) => node.id), []);

      const diagnosticsResponse = await fetch(`${url}/api/diagnostics`);
      const diagnostics = await assertJsonResponse(diagnosticsResponse, "/api/diagnostics");
      assert.equal(diagnostics.summary.totalNodes, 6);
      assert.deepEqual(diagnostics.leases.active.map((node) => node.id), ["A"]);

      const eventsResponse = await fetch(`${url}/api/events?limit=1&node=A&event=claimed`);
      const events = await assertJsonResponse(eventsResponse, "/api/events");
      assert.equal(events.length, 1);
      assert.equal(events[0].event, "claimed");
      assert.equal(events[0].nodeId, "A");

      const promptResponse = await fetch(
        `${url}/api/prompt?node=A&session=codex-B&run=run-preview&template=${encodeURIComponent("preview-template.md")}&cwd=${encodeURIComponent("/tmp/preview-cwd")}&report=${encodeURIComponent("reports/preview.md")}`
      );
      assert.equal(promptResponse.status, 200);
      assert.match(promptResponse.headers.get("content-type"), /^text\/plain/);
      assert.equal(
        await promptResponse.text(),
        "cwd=/tmp/preview-cwd\nnode=A\nsession=codex-B\nrun=run-preview\nreport=reports/preview.md\ntitle=Bootstrap\n"
      );

      assert.equal(await readFile(graphPath, "utf8"), before, "read-only routes should not mutate the graph file");
    } finally {
      await visualizer.close();
    }
  });
});

test("visualizer read-only parity routes validate query parameters", async () => {
  await withTempGraph(async (graphPath) => {
    const visualizer = await createVisualizerServer({ graphPath, port: 0 });
    try {
      const before = await readFile(graphPath, "utf8");

      const invalidLimit = await fetch(`${visualizer.url}/api/events?limit=0`);
      assert.equal(invalidLimit.status, 400);
      assert.match(await invalidLimit.text(), /Invalid --limit/);

      const tooLargeLimit = await fetch(`${visualizer.url}/api/events?limit=10001`);
      assert.equal(tooLargeLimit.status, 400);
      assert.match(await tooLargeLimit.text(), /Invalid --limit/);

      const duplicateLimit = await fetch(`${visualizer.url}/api/events?limit=1&limit=2`);
      assert.equal(duplicateLimit.status, 400);
      assert.match(await duplicateLimit.text(), /limit can only be provided once/);

      const missingPromptNode = await fetch(`${visualizer.url}/api/prompt`);
      assert.equal(missingPromptNode.status, 400);
      assert.match(await missingPromptNode.text(), /prompt requires node/);

      const blankPromptNode = await fetch(`${visualizer.url}/api/prompt?node=%20`);
      assert.equal(blankPromptNode.status, 400);
      assert.match(await blankPromptNode.text(), /prompt requires node/);

      const duplicatePromptNode = await fetch(`${visualizer.url}/api/prompt?node=A&node=B`);
      assert.equal(duplicatePromptNode.status, 400);
      assert.match(await duplicatePromptNode.text(), /node can only be provided once/);

      const duplicatePromptSession = await fetch(`${visualizer.url}/api/prompt?node=A&session=one&session=two`);
      assert.equal(duplicatePromptSession.status, 400);
      assert.match(await duplicatePromptSession.text(), /session can only be provided once/);

      assert.equal(
        await readFile(graphPath, "utf8"),
        before,
        "invalid read-only route queries should not mutate the graph file"
      );
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

test("Slack notification sends bounded chat context without report contents", async () => {
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
    assert.match(received[0].text, /report: reports\/A\.md/);
    assert.doesNotMatch(received[0].text, /Proceed\?|Use CLI\.|codex exited with 1|sensitive report body/i);
  });
});

test("Slack notification escapes hostile graph and detail markup", async () => {
  await withTempGraph(async (graphPath) => {
    const nodeId = 'A<@U123>|*bad*';
    const graph = fixtureGraph();
    graph.graph.root = nodeId;
    graph.graph.nodes = {
      [nodeId]: {
        title: "Title <!here> <http://example.invalid|click> _under_ *bold* `code` ~gone~\nnext",
        kind: "task",
        status: "pending"
      }
    };
    await writeFile(graphPath, `${JSON.stringify(graph, null, 2)}\n`, "utf8");

    const text = await buildSlackNotificationText(graphPath, "done*_~`<script>\nnext", {
      nodeId,
      report: "reports/<script>*_~`&\nA.md",
      reason: "not sent to chat"
    });

    assert.match(text, /\*DONE\\\*\\_\\~\\`&lt;SCRIPT&gt; NEXT\*/);
    assert.match(text, /A&lt;@U123&gt;\|\\\*bad\\\*/);
    assert.match(text, /Title &lt;!here&gt; &lt;http:\/\/example\.invalid\|click&gt; \\_under\\_ \\\*bold\\\* \\`code\\` \\~gone\\~ next/);
    assert.match(text, /report: reports\/&lt;script&gt;\\\*\\_\\~\\`&amp; A\.md/);
    assert.equal(text.split("\n").length, 3);
    assert.doesNotMatch(text, /<@|<!here|<http|<script>|not sent to chat/);
  });
});

test("Slack notification reports HTTP delivery failure without throwing", async () => {
  await withTempGraph(async (graphPath) => {
    const server = createServer((_request, response) => {
      response.writeHead(503, { "content-type": "text/plain" });
      response.end("unavailable");
    });

    await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
    const previousWebhook = process.env.SLACK_WEBHOOK_URL;
    try {
      const { port } = server.address();
      process.env.SLACK_WEBHOOK_URL = `http://127.0.0.1:${port}/slack`;
      assert.deepEqual(await sendSlackNotification(graphPath, "done", { nodeId: "A" }), {
        failed: true,
        reason: "Slack notification failed: HTTP 503"
      });
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
  });
});

test("Slack notification times out and returns a failure result", async () => {
  await withTempGraph(async (graphPath) => {
    const server = createServer(() => {});

    await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
    const previousWebhook = process.env.SLACK_WEBHOOK_URL;
    const previousTimeout = process.env.SPG_SLACK_TIMEOUT_MS;
    try {
      const { port } = server.address();
      process.env.SLACK_WEBHOOK_URL = `http://127.0.0.1:${port}/slack`;
      process.env.SPG_SLACK_TIMEOUT_MS = "25";
      assert.deepEqual(await sendSlackNotification(graphPath, "done", { nodeId: "A" }), {
        failed: true,
        reason: "Slack notification failed: timed out after 25ms"
      });
    } finally {
      if (previousWebhook === undefined) {
        delete process.env.SLACK_WEBHOOK_URL;
      } else {
        process.env.SLACK_WEBHOOK_URL = previousWebhook;
      }
      if (previousTimeout === undefined) {
        delete process.env.SPG_SLACK_TIMEOUT_MS;
      } else {
        process.env.SPG_SLACK_TIMEOUT_MS = previousTimeout;
      }
      server.closeAllConnections();
      await new Promise((resolveClose, rejectClose) => {
        server.close((error) => error ? rejectClose(error) : resolveClose());
      });
    }
  });
});

test("Slack notification text escapes graph-provided mrkdwn and link syntax", async () => {
  await withTempGraph(async (graphPath) => {
    const graph = await readGraph(graphPath);
    graph.graph.nodes.A.title = "Needs *review* <@U123> & <https://evil.test|link>";
    await writeFile(graphPath, `${JSON.stringify(graph, null, 2)}\n`, "utf8");

    const text = await buildSlackNotificationText(graphPath, "failed", {
      nodeId: "A",
      question: "Ping <!channel>\nreport: forged *now*",
      reason: "Bad <script>alert(1)</script> & retry",
      report: "reports/<A>*now*.md"
    });

    assert.match(text, /\*FAILED\* A - Needs \\\*review\\\* &lt;@U123&gt; &amp; &lt;https:\/\/evil\.test\|link&gt;/);
    assert.match(text, /report: reports\/&lt;A&gt;\\\*now\\\*\.md/);
    assert.doesNotMatch(text, /<@U123>|<!channel>|<script>|<https:\/\/evil\.test|forged|Bad &lt;script&gt;/);
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

test("visualizer worker API validates isolation remote and workspace fields", async () => {
  await withTempGraph(async (graphPath, dir) => {
    const visualizer = await createVisualizerServer({ graphPath, port: 0, defaultWorkerCwd: dir });
    try {
      const cases = [
        {
          body: { isolation: "container" },
          pattern: /Invalid isolation: expected off or git/
        },
        {
          body: { isolation: "git", remote: "TODO" },
          pattern: /Worker isolation remote is a placeholder and cannot be used: TODO/
        },
        {
          body: { isolation: "git", remote: ["git@example.com:org/repo.git"] },
          pattern: /Invalid remote: expected string/
        },
        {
          body: { isolation: "git", workspaceRoot: "../outside" },
          pattern: /Invalid workspaceRoot: path must stay inside the graph directory/
        },
        {
          body: { isolation: "git", workspaceRetention: "sometimes" },
          pattern: /Invalid workspaceRetention: expected on-failure, always, or never/
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

test("worker reports and Slack notifications redact configured secret-like environment values", async () => {
  const previousApiKey = process.env.SPG_TEST_API_KEY;
  process.env.SPG_TEST_API_KEY = "env-secret-value-12345";
  try {
    const report = formatWorkerReport({
      claim: {
        nodeId: "A",
        title: "Bootstrap",
        runId: "run-env-secret"
      },
      run: {
        code: 1,
        signal: null,
        stdout: "stdout leaked env-secret-value-12345",
        stderr: "",
        error: "error leaked env-secret-value-12345",
        command: "env-secret-value-12345",
        args: ["env-secret-value-12345"],
        cwd: "/tmp/work",
        startedAt: "2026-05-27T01:02:03.004Z",
        finishedAt: "2026-05-27T01:02:04.005Z",
        durationMs: 1001
      }
    });
    assert.match(report, /\[REDACTED\]/);
    assert.doesNotMatch(report, /env-secret-value-12345/);

    await withTempGraph(async (graphPath) => {
      const graph = await readGraph(graphPath);
      graph.graph.nodes.A.title = "Needs env-secret-value-12345";
      await writeFile(graphPath, `${JSON.stringify(graph, null, 2)}\n`, "utf8");

      const text = await buildSlackNotificationText(graphPath, "done", {
        nodeId: "A",
        report: "reports/env-secret-value-12345.md"
      });

      assert.match(text, /\[REDACTED\]/);
      assert.doesNotMatch(text, /env-secret-value-12345/);
    });
  } finally {
    if (previousApiKey === undefined) {
      delete process.env.SPG_TEST_API_KEY;
    } else {
      process.env.SPG_TEST_API_KEY = previousApiKey;
    }
  }
});

test("visualizer builds graph payload and real-time HTML shell", async () => {
  await withTempGraph(async (graphPath) => {
    const html = renderVisualizerHtml();
    assert.match(html, /EventSource\("\/events"\)/);
    assert.match(html, /Ready Leaf Nodes/);
    assert.match(html, /Active Sessions/);
    assert.match(html, /Diagnostics/);
    assert.match(html, /Recent Events/);
    assert.match(html, /Worker Manager/);
    assert.match(html, /\/api\/workers\/start/);
    assert.match(html, /id="graph"/);

    await claimNode(graphPath, { session: "codex-A", nodeId: "A" });
    const graph = await readGraph(graphPath);
    graph.graph.nodes.A.description = "Bootstrap the workspace";
    graph.graph.nodes.A.goal = { text: "Ship planner metadata", source: "planner" };
    graph.graph.nodes.A.planner = {
      name: "codex-planner",
      model: "gpt-5",
      requestId: "plan-A",
      decision: "Split the task after setup completes.",
      plannedAt: "2026-05-27T00:00:00.000Z"
    };
    graph.graph.nodes.A.decompositionReason = "Workspace bootstrap needs separate verification.";
    graph.graph.nodes.A.contextRefs = [{ type: "file", ref: "docs/planner-output-schema.md", title: "Planner schema" }];
    graph.graph.nodes.A.outputContract = {
      format: "markdown",
      requiredArtifacts: ["report"],
      acceptanceCriteria: ["Planner metadata is visible."]
    };
    graph.graph.nodes.A.resultSummary = {
      status: "partial",
      summary: "Bootstrap metadata was prepared.",
      artifacts: ["reports/A.md"]
    };
    graph.graph.nodes.A.deliverables = ["Workspace ready"];
    graph.graph.nodes.A.acceptanceCriteria = ["Tests can run"];
    graph.graph.nodes.A.baseRef = { name: "refs/remotes/origin/main" };
    graph.graph.nodes.A.workRef = { name: "refs/heads/spg/node/A/run-a" };
    graph.graph.nodes.A.outputRef = { name: "refs/heads/spg/node/A/run-a" };
    graph.graph.nodes.A.workspace = {
      remote: "https://user:secret-token@example.com/org/repo.git",
      cloneCwd: "/tmp/spg/workspaces/codex-A/A/run-a"
    };
    graph.graph.nodes.A.startedAt = "2026-05-27T00:00:01.000Z";
    graph.graph.nodes.A.history = Array.from({ length: 12 }, (_, index) => ({
      at: `2026-05-27T00:00:${String(index).padStart(2, "0")}.000Z`,
      event: index === 11 ? "clone-prepared" : "progress",
      cloneCwd: "/tmp/spg/workspaces/codex-A/A/run-a",
      bareRepo: "/tmp/spg/git/cache/repo.git",
      baseRef: "refs/remotes/origin/main",
      remote: "https://user:secret-token@example.com/org/repo.git"
    }));
    await writeFile(graphPath, `${JSON.stringify(graph, null, 2)}\n`, "utf8");
    const payload = await buildVisualizerPayload(graphPath);
    assert.equal(payload.summary.totalNodes, 6);
    assert.equal(payload.nodeHistoryLimit, 10);
    assert.equal(payload.nodes.length, 6);
    const detail = payload.nodes.find((node) => node.id === "A");
    assert.equal(detail.title, "Bootstrap");
    assert.equal(detail.kind, "task");
    assert.equal(detail.status, "claimed");
    assert.equal(detail.description, "Bootstrap the workspace");
    assert.equal(detail.goalText, "Ship planner metadata");
    assert.equal(detail.planner.name, "codex-planner");
    assert.equal(detail.plannerDecision, "Split the task after setup completes.");
    assert.equal(detail.decompositionReason, "Workspace bootstrap needs separate verification.");
    assert.deepEqual(detail.contextRefs, [{ type: "file", ref: "docs/planner-output-schema.md", title: "Planner schema" }]);
    assert.deepEqual(detail.outputContract.requiredArtifacts, ["report"]);
    assert.equal(detail.resultSummary.summary, "Bootstrap metadata was prepared.");
    assert.deepEqual(detail.children, []);
    assert.deepEqual(detail.deliverables, ["Workspace ready"]);
    assert.deepEqual(detail.acceptanceCriteria, ["Tests can run"]);
    assert.equal(detail.lease.session, "codex-A");
    assert.equal(detail.refs.baseRef.name, "refs/remotes/origin/main");
    assert.equal(detail.refs.workRef.name, "refs/heads/spg/node/A/run-a");
    assert.equal(detail.refs.outputRef.name, "refs/heads/spg/node/A/run-a");
    assert.equal(detail.workspace.remote, "https://[REDACTED]@example.com/org/repo.git");
    assert.equal(detail.workspace.cloneCwd, "/tmp/spg/workspaces/codex-A/A/run-a");
    assert.equal(detail.timestamps.startedAt, "2026-05-27T00:00:01.000Z");
    assert.equal(detail.historyCount, 12);
    assert.equal(detail.history.length, 10);
    assert.equal(detail.history[0].at, "2026-05-27T00:00:02.000Z");
    assert.equal(detail.history.at(-1).remote, "https://[REDACTED]@example.com/org/repo.git");
    assert.deepEqual(payload.ready.map((node) => node.id), []);
    const missingPlannerDetail = payload.nodes.find((node) => node.id === "B");
    assert.equal(missingPlannerDetail.goalText, undefined);
    assert.equal(missingPlannerDetail.plannerDecision, undefined);
    assert.equal(missingPlannerDetail.decompositionReason, undefined);
    assert.equal(missingPlannerDetail.outputContract, undefined);
    assert.equal(missingPlannerDetail.resultSummary, undefined);
    assert.deepEqual(payload.working.map((node) => node.id), ["A"]);
    assert.equal(payload.working[0].session, "codex-A");
    assert.equal(payload.working[0].isolation.cloneCwd, "/tmp/spg/workspaces/codex-A/A/run-a");
    assert.equal(payload.working[0].isolation.outputRef, "refs/heads/spg/node/A/run-a");
    assert.deepEqual(payload.attention.expired.nodeIds, []);
    assert.equal(payload.diagnostics.lock.exists, false);
    assert.equal(payload.recentEvents.length, 12);
    assert.equal(payload.recentEvents[0].event, "clone-prepared");
    assert.deepEqual(payload.workerManager.workers, []);
    assert.match(payload.graphSvg, /<svg class="sp-graph"/);
  });
});

test("visualizer and event payloads expose git footprints with redaction", async () => {
  await withTempGraph(async (graphPath) => {
    const graph = await readGraph(graphPath);
    graph.graph.nodes.A.status = "done";
    graph.graph.nodes.A.baseRef = {
      name: "refs/remotes/origin/main",
      commit: "1111111111111111111111111111111111111111"
    };
    graph.graph.nodes.A.outputRef = {
      name: "refs/heads/spg/node/A/run-a",
      commit: "2222222222222222222222222222222222222222",
      diffStat: { filesChanged: 1, additions: 4, deletions: 1, totalChanges: 5 },
      files: [{ path: "src/app.ts", changeType: "modified", additions: 4, deletions: 1, totalChanges: 5 }],
      collectedAt: "2026-05-27T00:05:01.000Z"
    };
    graph.graph.nodes.A.workspace = {
      remote: "https://user:secret-token@example.com/org/repo.git",
      cloneCwd: "/tmp/spg/token=workspace-secret/workspaces/codex-A/A/run-a"
    };
    graph.graph.nodes.A.history = [{
      at: "2026-05-27T00:05:02.000Z",
      event: "output-ref-recorded",
      status: "done",
      remote: "https://user:secret-token@example.com/org/repo.git",
      cloneCwd: "/tmp/spg/token=workspace-secret/workspaces/codex-A/A/run-a",
      outputRef: "refs/heads/spg/node/A/run-a",
      commit: "2222222222222222222222222222222222222222"
    }];
    await writeFile(graphPath, `${JSON.stringify(graph, null, 2)}\n`, "utf8");

    const payload = await buildVisualizerPayload(graphPath);
    const withFootprint = payload.nodes.find((node) => node.id === "A");
    const withoutFootprint = payload.nodes.find((node) => node.id === "B");
    assert.equal(withFootprint.git.commit, "2222222222222222222222222222222222222222");
    assert.equal(withFootprint.git.baseRef.display, "refs/remotes/origin/main @ 1111111111111111111111111111111111111111");
    assert.equal(withFootprint.git.outputRef.display, "refs/heads/spg/node/A/run-a @ 2222222222222222222222222222222222222222");
    assert.deepEqual(withFootprint.git.diffStat, { filesChanged: 1, insertions: 4, deletions: 1, totalChanges: 5 });
    assert.deepEqual(withFootprint.git.changedFiles.map((file) => [file.path, file.insertions, file.deletions]), [["src/app.ts", 4, 1]]);
    assert.equal(withFootprint.git.remoteDisplay, "https://[REDACTED]@example.com/org/repo.git");
    assert.equal(withoutFootprint.git, undefined);
    assert.equal(withFootprint.refs.gitFootprint.headRef.commit, "2222222222222222222222222222222222222222");
    assert.deepEqual(withFootprint.gitDiffStat, { filesChanged: 1, insertions: 4, deletions: 1, totalChanges: 5 });
    assert.deepEqual(withFootprint.changedFiles.map((file) => file.path), ["src/app.ts"]);
    assert.equal(withoutFootprint.refs.gitFootprint, undefined);
    assert.equal(withoutFootprint.gitFootprint, undefined);
    assert.deepEqual(payload.gitFootprint.refs.commits, ["2222222222222222222222222222222222222222"]);
    assert.deepEqual(payload.gitFootprint.changedFiles.map((file) => file.path), ["src/app.ts"]);
    assert.deepEqual(payload.diagnostics.gitFootprint.nodes.map((node) => node.nodeId), ["A"]);
    assert.equal(withFootprint.workspace.remote, "https://[REDACTED]@example.com/org/repo.git");
    assert.doesNotMatch(JSON.stringify(payload), /secret-token|workspace-secret/);
    assert.equal(payload.recentEvents[0].details.gitFootprint.headRef.commit, "2222222222222222222222222222222222222222");
    assert.deepEqual(payload.recentEvents[0].details.diffStat, { filesChanged: 1, additions: 4, deletions: 1, totalChanges: 5 });
  });
});

test("visualizer normalizes git details for old, task, and aggregate nodes", async () => {
  await withTempGraph(async (graphPath) => {
    const graph = await readGraph(graphPath);
    graph.graph.nodes.A.status = "done";
    graph.graph.nodes.A.baseRef = {
      name: "refs/remotes/origin/main",
      commit: "a".repeat(40)
    };
    graph.graph.nodes.A.outputRef = {
      name: "refs/heads/spg/node/A/run-a",
      commit: "b".repeat(40),
      diffStat: { filesChanged: 2, additions: 9, deletions: 3, totalChanges: 12 },
      files: [
        { path: "z-last.ts", changeType: "modified", additions: 5, deletions: 1, totalChanges: 6 },
        { path: "a-first.ts", changeType: "added", additions: 4, deletions: 2, totalChanges: 6 }
      ]
    };
    graph.graph.nodes.A.workspace = {
      remote: "https://user:secret-token@example.com/org/repo.git",
      bareRepo: "/tmp/spg/token=bare-secret/cache/repo.git",
      cloneCwd: "/tmp/spg/token=workspace-secret/workspaces/codex-A/A/run-a"
    };

    graph.graph.nodes.P.status = "done";
    graph.graph.nodes.P.integrationRef = {
      name: "refs/heads/spg/parent/P/run-p",
      status: "clean",
      publishedOutputRef: "refs/heads/spg/parent/P/output"
    };
    graph.graph.nodes.P.outputRef = {
      name: "refs/heads/spg/parent/P/output",
      commit: "c".repeat(40)
    };
    graph.graph.nodes.P.gitFootprint = {
      source: "child-aggregate",
      baseRef: { name: "refs/remotes/origin/main", commit: "a".repeat(40) },
      headRef: { name: "refs/heads/spg/parent/P/output", commit: "c".repeat(40) },
      branch: "spg/parent/P/output",
      commit: "c".repeat(40),
      diffStat: { filesChanged: 55, additions: 110, deletions: 11, totalChanges: 121 },
      files: Array.from({ length: 55 }, (_, index) => {
        const number = String(54 - index).padStart(2, "0");
        return {
          path: `src/file-${number}.ts`,
          changeType: "modified",
          additions: index,
          deletions: 1,
          totalChanges: index + 1,
          childIds: ["C", "B"]
        };
      }),
      aggregation: {
        source: "child-footprints",
        parentId: "P",
        parentKind: "parallel",
        childCount: 2,
        includedChildIds: ["B", "C"],
        missingChildIds: [],
        duplicateFilePaths: [],
        diffStatKind: "summed-child-stats",
        filesChangedKind: "unique-file-paths-with-stat-only-sum",
        fileMergeRule: "sum-line-counts-by-path"
      }
    };

    await writeFile(graphPath, `${JSON.stringify(graph, null, 2)}\n`, "utf8");

    const payload = await buildVisualizerPayload(graphPath);
    const oldNode = payload.nodes.find((node) => node.id === "B");
    const taskNode = payload.nodes.find((node) => node.id === "A");
    const aggregateNode = payload.nodes.find((node) => node.id === "P");

    assert.equal(oldNode.git, undefined);
    assert.equal(taskNode.git.commit, "b".repeat(40));
    assert.equal(taskNode.git.branch, "spg/node/A/run-a");
    assert.equal(taskNode.git.baseRef.name, "refs/remotes/origin/main");
    assert.equal(taskNode.git.outputRef.name, "refs/heads/spg/node/A/run-a");
    assert.deepEqual(taskNode.git.diffStat, { filesChanged: 2, insertions: 9, deletions: 3, totalChanges: 12 });
    assert.deepEqual(taskNode.git.changedFiles.map((file) => file.path), ["a-first.ts", "z-last.ts"]);
    assert.equal(taskNode.git.remoteDisplay, "https://[REDACTED]@example.com/org/repo.git");
    assert.equal(taskNode.workspaceDisplay.remote, "https://[REDACTED]@example.com/org/repo.git");

    assert.equal(aggregateNode.git.source, "child-aggregate");
    assert.equal(aggregateNode.git.commit, "c".repeat(40));
    assert.equal(aggregateNode.git.integrationRef.name, "refs/heads/spg/parent/P/run-p");
    assert.equal(aggregateNode.git.integrationRef.publishedOutputRef, "refs/heads/spg/parent/P/output");
    assert.deepEqual(aggregateNode.git.diffStat, { filesChanged: 55, insertions: 110, deletions: 11, totalChanges: 121 });
    assert.equal(aggregateNode.git.changedFiles.length, 50);
    assert.equal(aggregateNode.git.changedFilesTotal, 55);
    assert.equal(aggregateNode.git.changedFilesTruncated, 5);
    assert.equal(aggregateNode.git.changedFiles[0].path, "src/file-00.ts");
    assert.deepEqual(aggregateNode.git.changedFiles[0].childIds, ["B", "C"]);
    assert.equal(aggregateNode.changedFiles.length, 50);
    assert.doesNotMatch(JSON.stringify(payload.nodes), /secret-token|workspace-secret|bare-secret/);
  });
});

test("visualizer selected-node inspector renders git refs, diffstat, and changed files", async () => {
  await withTempGraph(async (graphPath) => {
    const graph = await readGraph(graphPath);
    graph.graph.nodes.A.status = "done";
    graph.graph.nodes.A.baseRef = {
      name: "refs/remotes/origin/main",
      commit: "1111111111111111111111111111111111111111"
    };
    graph.graph.nodes.A.workRef = {
      name: "refs/heads/spg/node/A/run-a",
      commit: "2222222222222222222222222222222222222222"
    };
    graph.graph.nodes.A.outputRef = {
      name: "refs/heads/spg/node/A/run-a",
      commit: "2222222222222222222222222222222222222222",
      diffStat: { filesChanged: 2, additions: 10, deletions: 3, totalChanges: 13 },
      files: [
        { path: "src/app.ts", changeType: "modified", additions: 8, deletions: 3, totalChanges: 11 },
        { path: "docs/new.md", changeType: "added", additions: 2, deletions: 0, totalChanges: 2 }
      ],
      collectedAt: "2026-05-27T00:05:01.000Z"
    };
    graph.graph.nodes.A.workspace = {
      remote: "https://user:secret-token@github.com/example-org/example-repo.git",
      cloneCwd: "/tmp/spg/workspaces/codex-A/A/run-a"
    };
    await writeFile(graphPath, `${JSON.stringify(graph, null, 2)}\n`, "utf8");

    const payload = await buildVisualizerPayload(graphPath);
    const { context, element } = runVisualizerClientScript();
    context.render(payload);
    context.selectNode("A");

    let html = element("selected-node-details").innerHTML;
    assert.match(html, /Git Refs/);
    assert.match(html, /Diffstat/);
    assert.match(html, /Changed Files/);
    assert.match(html, /src\/app\.ts/);
    assert.match(html, /docs\/new\.md/);
    assert.match(html, /href="https:\/\/github\.com\/example-org\/example-repo\/compare\/1111111111111111111111111111111111111111\.\.\.2222222222222222222222222222222222222222\.diff"/);
    assert.match(html, /href="https:\/\/github\.com\/example-org\/example-repo\/compare\/1111111111111111111111111111111111111111\.\.\.2222222222222222222222222222222222222222"/);
    assert.doesNotMatch(html, /secret-token/);

    context.selectNode("B");
    html = element("selected-node-details").innerHTML;
    assert.match(html, /No git refs recorded for this node/);
    assert.match(html, /compare disabled: Missing base ref and head ref\./);
    assert.match(html, /No changed files recorded for this node/);
  });
});

test("visualizer diagnostics payload exposes attention, events, and read-only lock state", async () => {
  await withTempGraph(async (graphPath) => {
    const graph = await readGraph(graphPath);
    graph.graph.nodes.A.status = "blocked";
    graph.graph.nodes.A.blockedReason = "needs_scope";
    graph.graph.nodes.A.history = [{
      at: "2026-05-27T00:01:00.000Z",
      event: "blocked",
      status: "blocked",
      blockedAt: "2026-05-27T00:01:00.000Z",
      question: "Proceed?"
    }];
    graph.graph.nodes.B.status = "failed";
    graph.graph.nodes.B.failureReason = "test failure";
    graph.graph.nodes.B.history = [{
      at: "2026-05-27T00:02:00.000Z",
      event: "failed",
      status: "failed",
      failedAt: "2026-05-27T00:02:00.000Z",
      failureReason: "test failure"
    }];
    graph.graph.nodes.C.status = "running";
    graph.graph.nodes.C.lease = {
      session: "codex-C",
      runId: "run-C",
      claimedAt: "2026-05-27T00:00:00.000Z",
      expiresAt: "2026-05-27T00:00:01.000Z"
    };
    graph.graph.nodes.C.history = [{
      at: "2026-05-27T00:00:00.000Z",
      event: "running",
      status: "running",
      session: "codex-C",
      runId: "run-C"
    }];
    await writeFile(graphPath, `${JSON.stringify(graph, null, 2)}\n`, "utf8");

    const lockPath = `${graphPath}.lock`;
    await mkdir(lockPath);
    await writeFile(join(lockPath, "metadata.json"), `${JSON.stringify({
      lockVersion: 1,
      ownerId: "owner-1",
      pid: 24680,
      host: "test-host",
      createdAt: "2026-05-27T00:00:00.000Z",
      graphPath
    })}\n`, "utf8");
    const oldTime = new Date(Date.now() - 20 * 60 * 1000);
    await utimes(lockPath, oldTime, oldTime);

    const workerManager = {
      status() {
        return {
          defaults: {
            cwd: "/tmp/work",
            sessionPrefix: "codex",
            codexCommand: "codex",
            isolation: "off",
            workspaceRoot: "runs/workspaces",
            workspaceRetention: "on-failure"
          },
          running: 0,
          stopping: 0,
          exited: 0,
          error: 1,
          retainedWorkers: 1,
          totalStarted: 1,
          workers: [{
            id: "worker-err",
            session: "codex-Z",
            status: "error",
            startedAt: "2026-05-27T00:00:00.000Z",
            durationMs: 1,
            logTail: []
          }]
        };
      }
    };

    const payload = await buildVisualizerPayload(graphPath, workerManager);
    assert.deepEqual(payload.attention.blocked.nodeIds, ["A"]);
    assert.deepEqual(payload.attention.failed.nodeIds, ["B"]);
    assert.deepEqual(payload.attention.expired.nodeIds, ["C"]);
    assert.equal(payload.attention.expired.releasable, 1);
    assert.deepEqual(payload.attention.workerErrors.workerIds, ["worker-err"]);
    assert.equal(payload.diagnostics.lock.exists, true);
    assert.equal(payload.diagnostics.lock.stale, true);
    assert.equal(payload.diagnostics.lock.owner.pid, 24680);
    assert.ok(payload.recentEvents.some((event) => event.event === "blocked" && event.nodeId === "A"));

    const { context, element } = runVisualizerClientScript();
    context.render(payload);
    const diagnosticsHtml = element("diagnostics").innerHTML;
    assert.match(diagnosticsHtml, /read-only/);
    assert.match(diagnosticsHtml, /Stale graph lock/);
    assert.doesNotMatch(diagnosticsHtml, /remove|rm -rf|delete/i);
  });
});

test("visualizer event API filters by node and event like the CLI", async () => {
  await withTempGraph(async (graphPath) => {
    const graph = await readGraph(graphPath);
    graph.graph.nodes.A.history = [
      { at: "2026-05-27T00:00:00.000Z", event: "claimed", status: "claimed" },
      { at: "2026-05-27T00:01:00.000Z", event: "blocked", status: "blocked", question: "Proceed?" }
    ];
    graph.graph.nodes.B.history = [
      { at: "2026-05-27T00:02:00.000Z", event: "blocked", status: "blocked", question: "Other?" }
    ];
    await writeFile(graphPath, `${JSON.stringify(graph, null, 2)}\n`, "utf8");

    const visualizer = await createVisualizerServer({ graphPath, port: 0 });
    try {
      const response = await fetch(`${visualizer.url}/api/events?node=A&event=blocked&limit=5`);
      assert.equal(response.status, 200);
      const events = await response.json();
      assert.deepEqual(events.map((event) => `${event.nodeId}:${event.event}`), ["A:blocked"]);

      const badLimit = await fetch(`${visualizer.url}/api/events?limit=NaN`);
      assert.equal(badLimit.status, 400);
      assert.match(await badLimit.text(), /Invalid --limit/);
    } finally {
      await visualizer.close();
    }
  });
});

test("visualizer payload includes selected-node action availability metadata", async () => {
  await withTempGraph(async (graphPath) => {
    let payload = await buildVisualizerPayload(graphPath);
    let detail = payload.nodes.find((node) => node.id === "A");
    let claim = actionById(detail, "claim");
    let reset = actionById(detail, "reset");
    assert.equal(claim.disabledReason, undefined);
    assert.equal(reset.danger, "danger");
    assert.equal(reset.confirmation.required, true);

    await claimNode(graphPath, { session: "codex-A", nodeId: "A" });
    payload = await buildVisualizerPayload(graphPath);
    detail = payload.nodes.find((node) => node.id === "A");
    const start = actionById(detail, "start");
    const fail = actionById(detail, "fail");
    assert.match(start.disabledReason, /no worker credentials/);
    assert.equal(start.requiredFields.includes("session|runId"), true);
    assert.equal(fail.danger, "danger");
    assert.equal(fail.confirmation.required, true);
    for (const action of detail.actions.filter((candidate) => candidate.danger === "danger")) {
      assert.equal(action.confirmation.required, true, `${action.id} should require confirmation`);
    }

    await blockNode(graphPath, { nodeId: "A", session: "codex-A", question: "Proceed?" });
    payload = await buildVisualizerPayload(graphPath);
    detail = payload.nodes.find((node) => node.id === "A");
    assert.equal(actionById(detail, "answer").disabledReason, undefined);
    assert.match(actionById(detail, "done").disabledReason, /no worker credentials/);
    assert.deepEqual(payload.actionPolicy.leaseProtectedWorkerActions, {
      whenCredentialsAbsent: "disable-leased-node-actions",
      requiredCredential: "matching-session-or-runId"
    });
    assert.equal(payload.actionPolicy.serverAuthority, "scheduler-mutation-guards");
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
        report: "<script>report()</script>",
        isolation: {
          cloneCwd: "<script>clone()</script>",
          baseRef: "<script>base()</script>",
          workRef: "<script>workref()</script>",
          outputRef: `${"x".repeat(1002)}<script>output()</script>`,
          integrationRef: "<script>integration()</script>",
          mergeRefs: [{ nodeId: "LEFT<script>", outputRef: "<script>merge()</script>" }],
          conflictedMergeRefs: [{ nodeId: "RIGHT<script>", outputRef: "<script>conflict()</script>" }]
        }
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
  assert.match(renderedHtml, /\[truncated from 1027 chars\]/);
  assert.doesNotMatch(renderedHtml, /output\(\)/);
  assert.doesNotMatch(renderedHtml, /<script\b/);
  assert.doesNotMatch(renderedHtml, /<img\b/);
});

test("selected-node inspector renders planner metadata as text", () => {
  const { context, element } = runVisualizerClientScript();
  const hostileGoal = "Goal <img src=x onerror=alert(1)>";
  const hostileDecision = "Use <script>decision()</script> safely.";
  const hostileReason = "Reason <img src=x onerror=alert(2)>";

  context.render({
    summary: { graphVersion: 1, totalNodes: 1, counts: { pending: 1 } },
    graphSvg: '<svg class="sp-graph"></svg>',
    nodes: [{
      id: "A",
      title: "Planner metadata",
      kind: "task",
      status: "pending",
      goal: { text: hostileGoal, source: "planner" },
      goalText: hostileGoal,
      planner: { name: "codex-planner", decision: hostileDecision },
      plannerDecision: hostileDecision,
      decompositionReason: hostileReason,
      contextRefs: [{ type: "file", ref: "docs/<script>.md", title: "Schema <img>" }],
      outputContract: {
        format: "markdown",
        requiredArtifacts: ["report <script>"],
        acceptanceCriteria: ["No <img> injection"]
      },
      resultSummary: {
        status: "partial",
        summary: "Result <script>summary()</script>",
        artifacts: ["reports/<img>.md"]
      },
      children: [],
      deliverables: [],
      acceptanceCriteria: [],
      refs: {},
      git: {
        commit: "<script>commit()</script>",
        branch: "spg/node/A/run-a",
        baseRef: { display: "refs/remotes/origin/main @ aaaa" },
        outputRef: { display: "refs/heads/spg/node/A/run-a @ bbbb" },
        diffStat: { filesChanged: 1, insertions: 2, deletions: 1, totalChanges: 3 },
        changedFiles: [{
          path: "src/<img>.ts",
          changeType: "modified",
          insertions: 2,
          deletions: 1,
          totalChanges: 3,
          binary: false
        }],
        changedFilesTotal: 1,
        changedFilesLimit: 50,
        changedFilesTruncated: 0,
        remoteDisplay: "https://[REDACTED]@example.com/org/repo.git",
        workspaceDisplay: "/tmp/token=[REDACTED]"
      },
      timestamps: {},
      history: [],
      historyCount: 0,
      historyLimit: 10,
      actions: []
    }],
    ready: [{ id: "A", title: "Planner metadata", status: "pending" }],
    working: [],
    workerManager: { defaults: { cwd: "", sessionPrefix: "codex", codexCommand: "codex" }, workers: [] },
    attention: {},
    diagnostics: {},
    recentEvents: []
  });
  context.selectNode("A");

  const inspector = element("selected-node-details");
  assert.match(inspector.textContent, /goal: Goal <img src=x onerror=alert\(1\)>/);
  assert.match(inspector.textContent, /decision: Use <script>decision\(\)<\/script> safely\./);
  assert.match(inspector.textContent, /decomposition reason: Reason <img src=x onerror=alert\(2\)>/);
  assert.match(inspector.textContent, /context: Schema <img> \/ file \/ docs\/<script>\.md/);
  assert.match(inspector.textContent, /output contract: format: markdown/);
  assert.match(inspector.textContent, /result: status: partial/);
  assert.match(inspector.textContent, /Git Footprint/);
  assert.match(inspector.textContent, /commit: <script>commit\(\)<\/script>/);
  assert.match(inspector.textContent, /diffstat: 1 files, \+2 \/ -1/);
  assert.match(inspector.textContent, /changed files: src\/<img>\.ts \[modified\] \+2 \/ -1/);
  assert.doesNotMatch(inspector.innerHTML, /<script\b/);
  assert.doesNotMatch(inspector.innerHTML, /<img\b/);
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
  graph.title = 'Escaping " <script>alert(0)</script>';
  graph.graph.nodes.B.title = '<script>alert(1)</script> & "quoted"';

  const svg = renderPlanarSvg(graph);
  assert.match(svg, /&lt;script&gt;/);
  assert.match(svg, /&quot;quoted&quot;/);
  assert.doesNotMatch(svg, /<script>/);
  assert.doesNotMatch(svg, /"quoted"/);
});

test("planar SVG renders compact ref and diffstat labels inside nodes", () => {
  const graph = fixtureGraph();
  graph.graph.nodes.A.outputRef = {
    name: "refs/heads/spg/node/A/run-a",
    commit: "2222222222222222222222222222222222222222",
    diffStat: { filesChanged: 3, insertions: 1200, deletions: 45, totalChanges: 1245 }
  };
  graph.graph.nodes.B.workRef = {
    name: "refs/heads/spg/node/B/run-b",
    commit: "3333333333333333333333333333333333333333"
  };
  graph.graph.nodes.C.baseRef = {
    name: "refs/heads/spg/node/C/fallback-ref-name-with-extra-text"
  };

  const layout = buildPlanarLayout(graph);
  const nodeA = layout.boxes.find((box) => box.id === "A");
  const nodeB = layout.boxes.find((box) => box.id === "B");
  const nodeC = layout.boxes.find((box) => box.id === "C");
  assert.deepEqual(nodeA.refLabel, { commit: "2222222", insertions: "+1.2k", deletions: "-45", filesChanged: "3f" });
  assert.deepEqual(nodeB.refLabel, { fallback: "3333333 ref" });
  assert.deepEqual(nodeC.refLabel, { fallback: "ref spg/node/C/fall..." });

  const svg = renderPlanarSvg(graph, { layout });
  assert.match(svg, /class="sp-node-ref"/);
  assert.match(svg, /<tspan class="sp-node-commit">2222222<\/tspan>/);
  assert.match(svg, /<tspan class="sp-node-insertions"> \+1\.2k<\/tspan>/);
  assert.match(svg, /<tspan class="sp-node-deletions"> -45<\/tspan>/);
  assert.match(svg, /<tspan class="sp-node-files"> 3f<\/tspan>/);
  assert.match(svg, /3333333 ref/);
  assert.match(svg, /ref spg\/node\/C\/fall\.\.\./);
});

test("planar SVG escapes hostile graph titles and node ids in attributes", () => {
  const nodeId = 'A" onload="alert(1)<script>';
  const graph = fixtureGraph();
  graph.title = 'Graph " <script>alert(0)</script>';
  graph.graph.root = nodeId;
  graph.graph.nodes = {
    [nodeId]: {
      title: 'Node " <img src=x onerror=alert(1)>',
      kind: 'task" autofocus="true',
      status: 'done" onmouseover="alert(1)'
    }
  };

  const svg = renderPlanarSvg(graph);
  assert.match(svg, /aria-label="Graph &quot; &lt;script&gt;alert\(0\)&lt;\/script&gt;"/);
  assert.match(svg, /data-id="A&quot; onload=&quot;alert\(1\)&lt;script&gt;"/);
  assert.match(svg, /A&quot; onload=&quot;alert\(1\)&lt;script&gt; · task&quot; autofocus=&quot;true/);
  assert.match(svg, /Node &quot; &lt;img src=x[\s\S]*onerror=alert\(1\)&gt;/);
  assert.doesNotMatch(svg, /<script>|<img\b|onload="alert|onmouseover="alert|autofocus="true/);
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
      { label: "Obfuscated", href: "jav\tascript:alert(2)" },
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
    assert.match(html, /<a href="#">Obfuscated<\/a>/);
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

test("static renderer keeps nav hrefs to safe browser targets", async () => {
  const dir = await mkdtemp(join(tmpdir(), "plan-render-hrefs-"));
  const inputPath = join(dir, "plan.graph.json");
  const outputPath = join(dir, "plan.html");
  const graph = fixtureGraph();
  graph.document = {
    nav: [
      { label: "HTTPS", href: " HTTPS://example.test/a\nb " },
      { label: "Mail", href: "mailto:owner@example.test" },
      { label: "Anchor", href: "#graph" },
      { label: "Relative", href: "docs/plan.html?x=<unsafe>" },
      { label: "Data", href: "data:text/html,<script>alert(1)</script>" },
      { label: "VB", href: "vbscript:msgbox(1)" },
      { label: "Split", href: "java script:alert(1)" }
    ],
    sections: [{ heading: "Links", paragraphs: ["Href safety"] }]
  };
  await writeFile(inputPath, `${JSON.stringify(graph, null, 2)}\n`, "utf8");

  try {
    await execFileAsync(process.execPath, [rendererScriptPath, "--graph", inputPath, "--output", outputPath]);
    const html = await readFile(outputPath, "utf8");
    assert.match(html, /<a href="HTTPS:\/\/example\.test\/ab">HTTPS<\/a>/);
    assert.match(html, /<a href="mailto:owner@example\.test">Mail<\/a>/);
    assert.match(html, /<a href="#graph">Anchor<\/a>/);
    assert.match(html, /<a href="docs\/plan\.html\?x=&lt;unsafe&gt;">Relative<\/a>/);
    assert.match(html, /<a href="#">Data<\/a>/);
    assert.match(html, /<a href="#">VB<\/a>/);
    assert.match(html, /<a href="#">Split<\/a>/);
    assert.doesNotMatch(html, /data:text\/html/);
    assert.doesNotMatch(html, /vbscript:/);
    assert.doesNotMatch(html, /java script:/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("static renderer emits labeled graph figure and structural tables", async () => {
  const dir = await mkdtemp(join(tmpdir(), "plan-render-table-"));
  const inputPath = join(dir, "plan.graph.json");
  const outputPath = join(dir, "plan.html");
  const graph = fixtureGraph();
  graph.document = {
    pageTitle: "Table Rendering",
    notation: {
      heading: "Notation",
      columns: ["Syntax", "Meaning"],
      rows: [["<code>S(A,B)</code>", "series"], ["P(A,B)", "parallel", "extra cell"]]
    },
    gates: {
      heading: "Gates",
      columns: [],
      rows: [["Review gate"]]
    }
  };
  await writeFile(inputPath, `${JSON.stringify(graph, null, 2)}\n`, "utf8");

  try {
    await execFileAsync(process.execPath, [rendererScriptPath, inputPath, outputPath]);
    const html = await readFile(outputPath, "utf8");
    assert.match(html, /<section class="graph-section" aria-labelledby="graph-heading">/);
    assert.match(html, /<figure class="graph-figure" aria-labelledby="graph-heading graph-caption">/);
    assert.match(html, /<figcaption id="graph-caption">Series-parallel dependency graph for Fixture Implementation Plan\.<\/figcaption>/);
    assert.match(html, /<div class="table-viewport">\s*<table aria-labelledby="notation-heading">/);
    assert.match(html, /<th scope="col">Syntax<\/th>/);
    assert.match(html, /<th scope="col">Column 3<\/th>/);
    assert.match(html, /<td><code>S\(A,B\)<\/code><\/td>/);
    assert.match(html, /<table aria-labelledby="gates-heading">/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("static renderer handles missing optional document fields without placeholder text", async () => {
  const dir = await mkdtemp(join(tmpdir(), "plan-render-sparse-"));
  const inputPath = join(dir, "plan.graph.json");
  const outputPath = join(dir, "plan.html");
  const graph = fixtureGraph();
  delete graph.title;
  graph.document = {};
  await writeFile(inputPath, `${JSON.stringify(graph, null, 2)}\n`, "utf8");

  try {
    await execFileAsync(process.execPath, [rendererScriptPath, "--graph", inputPath, "--output", outputPath]);
    const html = await readFile(outputPath, "utf8");
    assert.match(html, /<title>Series-Parallel Plan<\/title>/);
    assert.match(html, /<h1>Series-Parallel Plan<\/h1>/);
    assert.match(html, /<h2 id="graph-heading">Planar Graph View<\/h2>/);
    assert.doesNotMatch(html, /undefined/);
    assert.doesNotMatch(html, /<table/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("static renderer leaves existing output unchanged when document content is missing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "plan-render-documentless-"));
  const inputPath = join(dir, "plan.graph.json");
  const outputPath = join(dir, "plan.html");
  const graph = fixtureGraph();
  const previousHtml = "<!doctype html><p>previous output</p>\n";
  await writeFile(inputPath, `${JSON.stringify(graph, null, 2)}\n`, "utf8");
  await writeFile(outputPath, previousHtml, "utf8");

  try {
    await assert.rejects(
      () => execFileAsync(process.execPath, [rendererScriptPath, "--graph", inputPath, "--output", outputPath]),
      /missing document content/
    );
    assert.equal(await readFile(outputPath, "utf8"), previousHtml);
    assert.deepEqual((await readdir(dir)).sort(), ["plan.graph.json", "plan.html"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("static renderer preserves natural SVG dimensions for large graphs inside scrollable viewports", async () => {
  const dir = await mkdtemp(join(tmpdir(), "plan-render-large-"));
  const inputPath = join(dir, "plan.graph.json");
  const outputPath = join(dir, "plan.html");
  const childIds = Array.from({ length: 36 }, (_, index) => `N${index + 1}`);
  const graph = {
    graphVersion: 1,
    title: "Large Render Plan",
    graph: {
      root: "ROOT",
      nodes: {
        ROOT: { title: "Root", kind: "series", status: "pending", children: childIds },
        ...Object.fromEntries(childIds.map((id, index) => [id, { title: `Large render task ${index + 1}`, kind: "task", status: "pending" }]))
      }
    },
    document: {
      intro: ["Large graph rendering should remain scrollable and readable."],
      sections: [{ heading: "Scale", paragraphs: ["Reasonable large graphs render to static HTML."] }]
    }
  };
  await writeFile(inputPath, `${JSON.stringify(graph, null, 2)}\n`, "utf8");

  try {
    await execFileAsync(process.execPath, [rendererScriptPath, "--graph", inputPath, "--output", outputPath]);
    const html = await readFile(outputPath, "utf8");
    const width = Number(html.match(/<svg class="sp-graph" width="(\d+)"/)?.[1]);
    assert.ok(width > 9000, `expected a large natural SVG width, got ${width}`);
    assert.match(html, /\.graph-viewport \{\s*border: 1px solid var\(--line\);[\s\S]*overflow: auto;/);
    assert.match(html, /\.sp-graph \{[\s\S]*width: auto;[\s\S]*max-width: none;/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
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

function actionById(node, id) {
  const action = node?.actions.find((candidate) => candidate.id === id);
  assert.ok(action, `missing action ${id}`);
  return action;
}
