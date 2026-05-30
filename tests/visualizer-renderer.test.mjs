import test from "node:test";
import { assert, assertInvalidFixtureFailure, blockNode, buildPlanarLayout, buildSlackNotificationText, buildVisualizerPayload, claimNode, completeNode, copyGraphFixtureToTemp, createServer, createVisualizerServer, dirname, execFileAsync, existsSync, fixtureGraph, formatWorkerReport, invalidGraphValidatorOutcomes, isLocalVisualizerHost, join, mkdtemp, readFile, readGraph, readdir, renderPlanarSvg, renderVisualizerHtml, rendererDocumentFixture, rendererScriptPath, rm, runVisualizerClientScript, schedulerScriptPath, sendSlackNotification, startNode, tmpdir, visualizerHostSecurityWarning, waitFor, withTempGraph, writeFile } from "./helpers/plan-scheduler-harness.mjs";

async function postJson(baseUrl, pathname, body, headers = {}) {
  return fetch(`${baseUrl}${pathname}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body)
  });
}

async function postJsonOk(baseUrl, pathname, body, headers) {
  const response = await postJson(baseUrl, pathname, body, headers);
  if (response.status !== 200) {
    assert.fail(await response.text());
  }
  return response.json();
}

function assertSlackSkipped(result) {
  assert.deepEqual(result.slack, {
    skipped: true,
    reason: "SLACK_WEBHOOK_URL is not set"
  });
}

function assertNodeHistoryEvent(graph, nodeId, event) {
  assert.ok(
    graph.graph.nodes[nodeId].history?.some((entry) => entry.event === event),
    `${nodeId} should record ${event}`
  );
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

test("visualizer warns when worker controls bind beyond loopback", async () => {
  assert.equal(isLocalVisualizerHost("127.0.0.1"), true);
  assert.equal(isLocalVisualizerHost("localhost"), true);
  assert.equal(isLocalVisualizerHost("::1"), true);
  assert.equal(isLocalVisualizerHost("0.0.0.0"), false);
  assert.equal(isLocalVisualizerHost("192.168.1.10"), false);
  assert.equal(visualizerHostSecurityWarning("127.0.0.1"), undefined);
  assert.match(visualizerHostSecurityWarning("0.0.0.0"), /trusted local use/);
  assert.match(visualizerHostSecurityWarning("192.168.1.10"), /worker start\/stop controls/);
  assert.match(visualizerHostSecurityWarning("0.0.0.0", true), /unsafe visualizer writes are enabled/);
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
  await withTempGraph(async (graphPath) => {
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

      const forbiddenClaim = await postJson(url, "/api/claim", { nodeId: "B", session: "api-denied" });
      assert.equal(forbiddenClaim.status, 403);

      const forbiddenAnswer = await fetch(`${url}/api/answer`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-spg-visualizer-token": "wrong-token" },
        body: JSON.stringify({ nodeId: "A", answer: "No" })
      });
      assert.equal(forbiddenAnswer.status, 403);

      const forbiddenDone = await postJson(url, "/api/done", { nodeId: "A", session: "codex-A" }, {
        "x-spg-visualizer-token": "wrong-token"
      });
      assert.equal(forbiddenDone.status, 403);

      const answerResponse = await fetch(`${url}/api/answer`, {
        method: "POST",
        headers: { "content-type": "application/json", "authorization": "Bearer secret-token" },
        body: JSON.stringify({ nodeId: "A", answer: "Yes, use cache.", responder: "test" })
      });
      assert.equal(answerResponse.status, 200);
      assert.equal((await answerResponse.json()).answer, "Yes, use cache.");

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

test("visualizer reconcile API completes internal parents and refreshes graph payload", async () => {
  await withTempGraph(async (graphPath) => {
    const graph = {
      graphVersion: 1,
      title: "Visualizer Reconcile Plan",
      graph: {
        root: "ROOT",
        nodes: {
          ROOT: { title: "Root", kind: "series", status: "pending", children: ["PARENT", "NEXT"] },
          PARENT: { title: "Parent", kind: "series", status: "pending", children: ["A", "B"] },
          A: { title: "Done A", kind: "task", status: "done" },
          B: { title: "Done B", kind: "task", status: "done" },
          NEXT: { title: "Next task", kind: "task", status: "pending" }
        }
      }
    };
    await writeFile(graphPath, `${JSON.stringify(graph, null, 2)}\n`, "utf8");

    const visualizer = await createVisualizerServer({ graphPath, port: 0, writeToken: "secret-token" });
    try {
      const forbidden = await fetch(`${visualizer.url}/api/graph/reconcile`, { method: "POST" });
      assert.equal(forbidden.status, 403);
      assert.equal((await readGraph(graphPath)).graph.nodes.PARENT.status, "pending");

      const response = await fetch(`${visualizer.url}/api/graph/reconcile`, {
        method: "POST",
        headers: { "x-spg-visualizer-token": "secret-token" }
      });
      assert.equal(response.status, 200);

      const result = await response.json();
      assert.deepEqual(result.changed, ["PARENT"]);
      assert.equal(result.summary.graphVersion, 2);
      assert.deepEqual(result.summary.counts, { pending: 2, done: 3 });

      const updated = await readGraph(graphPath);
      assert.equal(updated.graph.nodes.PARENT.status, "done");
      assert.equal(updated.graph.nodes.ROOT.status, "pending");

      const payload = await (await fetch(`${visualizer.url}/api/graph`)).json();
      assert.deepEqual(payload.ready.map((node) => node.id), ["NEXT"]);
      assert.deepEqual(payload.summary, result.summary);
    } finally {
      await visualizer.close();
    }
  });
});

test("visualizer release-expired API releases expired claimed and running leases only", async () => {
  await withTempGraph(async (graphPath) => {
    const expired = "2000-01-01T00:00:00.000Z";
    const active = "2999-01-01T00:00:00.000Z";
    const leasedNode = (title, status, session, runId, expiresAt) => ({
      title,
      kind: "task",
      status,
      ...(status === "running" ? { startedAt: "2026-05-30T00:00:00.000Z" } : {}),
      lease: {
        session,
        runId,
        claimedAt: "2026-05-30T00:00:00.000Z",
        expiresAt
      }
    });
    const graph = {
      graphVersion: 1,
      title: "Visualizer Lease Recovery Plan",
      graph: {
        root: "ROOT",
        nodes: {
          ROOT: {
            title: "Root",
            kind: "parallel",
            status: "pending",
            children: ["CLAIMED_EXPIRED", "RUNNING_EXPIRED", "CLAIMED_ACTIVE", "RUNNING_ACTIVE", "BLOCKED_EXPIRED"]
          },
          CLAIMED_EXPIRED: leasedNode("Claimed expired", "claimed", "codex-expired", "run-claimed-expired", expired),
          RUNNING_EXPIRED: leasedNode("Running expired", "running", "codex-expired", "run-running-expired", expired),
          CLAIMED_ACTIVE: leasedNode("Claimed active", "claimed", "codex-active", "run-claimed-active", active),
          RUNNING_ACTIVE: leasedNode("Running active", "running", "codex-active", "run-running-active", active),
          BLOCKED_EXPIRED: leasedNode("Blocked expired", "blocked", "codex-blocked", "run-blocked-expired", expired)
        }
      }
    };
    await writeFile(graphPath, `${JSON.stringify(graph, null, 2)}\n`, "utf8");

    const visualizer = await createVisualizerServer({ graphPath, port: 0, writeToken: "secret-token" });
    try {
      const forbidden = await fetch(`${visualizer.url}/api/leases/release-expired`, { method: "POST" });
      assert.equal(forbidden.status, 403);
      assert.equal((await readGraph(graphPath)).graph.nodes.CLAIMED_EXPIRED.status, "claimed");

      const response = await fetch(`${visualizer.url}/api/leases/release-expired`, {
        method: "POST",
        headers: { authorization: "Bearer secret-token" }
      });
      assert.equal(response.status, 200);

      const result = await response.json();
      assert.deepEqual(result.released, ["CLAIMED_EXPIRED", "RUNNING_EXPIRED"]);
      assert.equal(result.summary.graphVersion, 2);
      assert.deepEqual(result.summary.counts, { pending: 3, claimed: 1, running: 1, blocked: 1 });

      const updated = await readGraph(graphPath);
      assert.equal(updated.graph.nodes.CLAIMED_EXPIRED.status, "pending");
      assert.equal(updated.graph.nodes.RUNNING_EXPIRED.status, "pending");
      assert.equal(updated.graph.nodes.CLAIMED_ACTIVE.status, "claimed");
      assert.equal(updated.graph.nodes.RUNNING_ACTIVE.status, "running");
      assert.equal(updated.graph.nodes.BLOCKED_EXPIRED.status, "blocked");
      assert.equal(updated.graph.nodes.CLAIMED_ACTIVE.lease.expiresAt, active);
      assert.equal(updated.graph.nodes.RUNNING_ACTIVE.lease.expiresAt, active);
      assert.equal(updated.graph.nodes.BLOCKED_EXPIRED.lease.expiresAt, expired);

      const payload = await (await fetch(`${visualizer.url}/api/graph`)).json();
      assert.deepEqual(payload.working.map((node) => node.id), ["BLOCKED_EXPIRED", "CLAIMED_ACTIVE", "RUNNING_ACTIVE"]);
      assert.deepEqual(payload.summary, result.summary);
    } finally {
      await visualizer.close();
    }
  });
});

test("visualizer node mutation APIs persist graph updates", async (t) => {
  await t.test("claim", async () => {
    await withTempGraph(async (graphPath) => {
      const visualizer = await createVisualizerServer({ graphPath, port: 0 });
      try {
        const result = await postJsonOk(visualizer.url, "/api/claim", {
          nodeId: "A",
          session: "api-claim",
          leaseSeconds: 60
        });
        assert.equal(result.nodeId, "A");
        assert.equal(result.lease.session, "api-claim");
        assert.equal(result.summary.counts.claimed, 1);

        const graph = await readGraph(graphPath);
        assert.equal(graph.graph.nodes.A.status, "claimed");
        assert.equal(graph.graph.nodes.A.lease.session, "api-claim");
        assertNodeHistoryEvent(graph, "A", "claimed");
      } finally {
        await visualizer.close();
      }
    });
  });

  await t.test("start", async () => {
    await withTempGraph(async (graphPath) => {
      const claim = await claimNode(graphPath, { nodeId: "A", session: "api-start" });
      const visualizer = await createVisualizerServer({ graphPath, port: 0 });
      try {
        const result = await postJsonOk(visualizer.url, "/api/start", {
          nodeId: "A",
          session: "api-start",
          runId: claim.runId
        });
        assert.equal(result.status, "running");
        assert.equal(result.summary.counts.running, 1);

        const graph = await readGraph(graphPath);
        assert.equal(graph.graph.nodes.A.status, "running");
        assert.ok(graph.graph.nodes.A.startedAt);
        assertNodeHistoryEvent(graph, "A", "running");
      } finally {
        await visualizer.close();
      }
    });
  });

  await t.test("renew", async () => {
    await withTempGraph(async (graphPath) => {
      const claim = await claimNode(graphPath, { nodeId: "A", session: "api-renew" });
      const visualizer = await createVisualizerServer({ graphPath, port: 0 });
      try {
        const result = await postJsonOk(visualizer.url, "/api/renew", {
          nodeId: "A",
          session: "api-renew",
          runId: claim.runId,
          leaseSeconds: 120
        });
        assert.equal(result.nodeId, "A");
        assert.ok(result.lease.renewedAt);

        const graph = await readGraph(graphPath);
        assert.equal(graph.graph.nodes.A.lease.renewedAt, result.lease.renewedAt);
        assertNodeHistoryEvent(graph, "A", "renewed");
      } finally {
        await visualizer.close();
      }
    });
  });

  await t.test("done", async () => {
    await withTempGraph(async (graphPath, dir) => {
      const claim = await claimNode(graphPath, { nodeId: "A", session: "api-done" });
      await startNode(graphPath, { nodeId: "A", session: "api-done", runId: claim.runId });
      const visualizer = await createVisualizerServer({ graphPath, port: 0 });
      try {
        const result = await postJsonOk(visualizer.url, "/api/done", {
          nodeId: "A",
          session: "api-done",
          runId: claim.runId,
          report: "reports/api-done.md",
          reportBody: "API route done body"
        });
        assert.equal(result.status, "done");
        assertSlackSkipped(result);
        assert.equal(await readFile(join(dir, "reports", "api-done.md"), "utf8"), "API route done body\n");

        const graph = await readGraph(graphPath);
        assert.equal(graph.graph.nodes.A.status, "done");
        assert.equal(graph.graph.nodes.A.report, "reports/api-done.md");
        assert.equal(graph.graph.nodes.A.lease, undefined);
        assertNodeHistoryEvent(graph, "A", "done");
      } finally {
        await visualizer.close();
      }
    });
  });

  await t.test("block and answer", async () => {
    await withTempGraph(async (graphPath) => {
      const claim = await claimNode(graphPath, { nodeId: "A", session: "api-block" });
      await startNode(graphPath, { nodeId: "A", session: "api-block", runId: claim.runId });
      const visualizer = await createVisualizerServer({ graphPath, port: 0 });
      try {
        const blockResult = await postJsonOk(visualizer.url, "/api/block", {
          nodeId: "A",
          session: "api-block",
          runId: claim.runId,
          question: "Proceed?",
          reason: "needs_operator_decision"
        });
        assert.equal(blockResult.status, "blocked");
        assertSlackSkipped(blockResult);

        let graph = await readGraph(graphPath);
        assert.equal(graph.graph.nodes.A.status, "blocked");
        assert.equal(graph.graph.nodes.A.question, "Proceed?");
        assertNodeHistoryEvent(graph, "A", "blocked");

        const answerResult = await postJsonOk(visualizer.url, "/api/answer", {
          nodeId: "A",
          answer: "Proceed.",
          responder: "operator"
        });
        assert.equal(answerResult.status, "pending");
        assertSlackSkipped(answerResult);

        graph = await readGraph(graphPath);
        assert.equal(graph.graph.nodes.A.status, "pending");
        assert.equal(graph.graph.nodes.A.answer, "Proceed.");
        assert.equal(graph.graph.nodes.A.lease, undefined);
        assertNodeHistoryEvent(graph, "A", "answered");
      } finally {
        await visualizer.close();
      }
    });
  });

  await t.test("fail", async () => {
    await withTempGraph(async (graphPath) => {
      const claim = await claimNode(graphPath, { nodeId: "A", session: "api-fail" });
      await startNode(graphPath, { nodeId: "A", session: "api-fail", runId: claim.runId });
      const visualizer = await createVisualizerServer({ graphPath, port: 0 });
      try {
        const result = await postJsonOk(visualizer.url, "/api/fail", {
          nodeId: "A",
          session: "api-fail",
          runId: claim.runId,
          reason: "tests failed",
          report: "reports/api-fail.md"
        });
        assert.equal(result.status, "failed");
        assertSlackSkipped(result);

        const graph = await readGraph(graphPath);
        assert.equal(graph.graph.nodes.A.status, "failed");
        assert.equal(graph.graph.nodes.A.failureReason, "tests failed");
        assert.equal(graph.graph.nodes.A.report, "reports/api-fail.md");
        assertNodeHistoryEvent(graph, "A", "failed");
      } finally {
        await visualizer.close();
      }
    });
  });

  await t.test("reset", async () => {
    await withTempGraph(async (graphPath) => {
      await claimNode(graphPath, { nodeId: "A", session: "api-reset" });
      const visualizer = await createVisualizerServer({ graphPath, port: 0 });
      try {
        const result = await postJsonOk(visualizer.url, "/api/reset", {
          nodeId: "A",
          reason: "retry"
        });
        assert.equal(result.status, "pending");

        const graph = await readGraph(graphPath);
        assert.equal(graph.graph.nodes.A.status, "pending");
        assert.equal(graph.graph.nodes.A.lease, undefined);
        assertNodeHistoryEvent(graph, "A", "reset");
      } finally {
        await visualizer.close();
      }
    });
  });

  await t.test("reset-subtree", async () => {
    await withTempGraph(async (graphPath) => {
      await claimNode(graphPath, { nodeId: "A", session: "api-a" });
      await completeNode(graphPath, { nodeId: "A", session: "api-a", report: "reports/A.md" });
      await claimNode(graphPath, { nodeId: "B", session: "api-b" });
      const visualizer = await createVisualizerServer({ graphPath, port: 0 });
      try {
        const result = await postJsonOk(visualizer.url, "/api/reset-subtree", {
          nodeId: "P",
          reason: "rerun fanout"
        });
        assert.deepEqual(result.resetNodes, ["P", "B", "C"]);

        const graph = await readGraph(graphPath);
        assert.equal(graph.graph.nodes.P.status, "pending");
        assert.equal(graph.graph.nodes.B.status, "pending");
        assert.equal(graph.graph.nodes.B.lease, undefined);
        assert.equal(graph.graph.nodes.A.status, "done");
        assertNodeHistoryEvent(graph, "B", "reset");
      } finally {
        await visualizer.close();
      }
    });
  });

  await t.test("reset-reachable", async () => {
    await withTempGraph(async (graphPath) => {
      for (const nodeId of ["A", "B", "C", "G"]) {
        await claimNode(graphPath, { nodeId, session: `api-${nodeId}` });
        await completeNode(graphPath, { nodeId, session: `api-${nodeId}`, report: `reports/${nodeId}.md` });
      }
      const visualizer = await createVisualizerServer({ graphPath, port: 0 });
      try {
        const result = await postJsonOk(visualizer.url, "/api/reset-reachable", {
          nodeId: "B",
          reason: "rerun branch B"
        });
        assert.deepEqual(result.resetNodes, ["B", "G"]);

        const graph = await readGraph(graphPath);
        assert.equal(graph.graph.nodes.B.status, "pending");
        assert.equal(graph.graph.nodes.B.report, undefined);
        assert.equal(graph.graph.nodes.C.status, "done");
        assert.equal(graph.graph.nodes.G.status, "pending");
        assertNodeHistoryEvent(graph, "G", "reset");
      } finally {
        await visualizer.close();
      }
    });
  });

  await t.test("decompose", async () => {
    await withTempGraph(async (graphPath) => {
      const claim = await claimNode(graphPath, { nodeId: "A", session: "api-decompose" });
      const visualizer = await createVisualizerServer({ graphPath, port: 0 });
      try {
        const result = await postJsonOk(visualizer.url, "/api/decompose", {
          nodeId: "A",
          session: "api-decompose",
          runId: claim.runId,
          kind: "series",
          children: [
            { id: "A1", title: "First child" },
            { id: "A2", title: "Second child" }
          ]
        });
        assert.deepEqual(result.children, ["A1", "A2"]);
        assertSlackSkipped(result);

        const graph = await readGraph(graphPath);
        assert.equal(graph.graph.nodes.A.status, "pending");
        assert.equal(graph.graph.nodes.A.kind, "series");
        assert.deepEqual(graph.graph.nodes.A.children, ["A1", "A2"]);
        assert.equal(graph.graph.nodes.A.lease, undefined);
        assert.equal(graph.graph.nodes.A1.title, "First child");
        assertNodeHistoryEvent(graph, "A", "decomposed");
      } finally {
        await visualizer.close();
      }
    });
  });
});

test("visualizer node mutation APIs report lease mismatches without changing owners", async (t) => {
  const cases = [
    { route: "/api/start", status: "claimed" },
    { route: "/api/renew", status: "claimed" },
    { route: "/api/done", status: "claimed" },
    { route: "/api/block", status: "claimed" },
    { route: "/api/fail", status: "claimed" }
  ];

  for (const { route, status } of cases) {
    await t.test(route, async () => {
      await withTempGraph(async (graphPath) => {
        const claim = await claimNode(graphPath, { nodeId: "A", session: "lease-owner" });
        const visualizer = await createVisualizerServer({ graphPath, port: 0 });
        try {
          const response = await postJson(visualizer.url, route, {
            nodeId: "A",
            session: "wrong-owner",
            runId: claim.runId
          });
          assert.equal(response.status, 500);
          assert.match(await response.text(), /Lease session mismatch/);

          const graph = await readGraph(graphPath);
          assert.equal(graph.graph.nodes.A.status, status);
          assert.equal(graph.graph.nodes.A.lease.session, "lease-owner");
        } finally {
          await visualizer.close();
        }
      });
    });
  }
});

test("visualizer done API refuses report-body paths outside the graph directory", async () => {
  await withTempGraph(async (graphPath) => {
    await claimNode(graphPath, { nodeId: "A", session: "api-containment" });
    const escapedName = `spg-api-escaped-${Date.now()}.md`;
    const escapedPath = join(dirname(graphPath), "..", escapedName);
    const visualizer = await createVisualizerServer({ graphPath, port: 0 });
    try {
      const response = await postJson(visualizer.url, "/api/done", {
        nodeId: "A",
        session: "api-containment",
        report: `../${escapedName}`,
        reportBody: "must not escape"
      });
      assert.equal(response.status, 500);
      assert.match(await response.text(), /Path escapes graph directory/);
      assert.equal(existsSync(escapedPath), false);

      const graph = await readGraph(graphPath);
      assert.equal(graph.graph.nodes.A.status, "claimed");
      assert.equal(graph.graph.nodes.A.report, undefined);
    } finally {
      await visualizer.close();
      await rm(escapedPath, { force: true });
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
    assert.match(html, /Worker Manager/);
    assert.match(html, /\/api\/workers\/start/);
    assert.match(html, /id="graph"/);

    await claimNode(graphPath, { session: "codex-A", nodeId: "A" });
    const graph = await readGraph(graphPath);
    graph.graph.nodes.A.baseRef = { name: "refs/remotes/origin/main" };
    graph.graph.nodes.A.workRef = { name: "refs/heads/spg/node/A/run-a" };
    graph.graph.nodes.A.outputRef = { name: "refs/heads/spg/node/A/run-a" };
    graph.graph.nodes.A.history = [{
      at: "2026-05-27T00:00:00.000Z",
      event: "clone-prepared",
      cloneCwd: "/tmp/spg/workspaces/codex-A/A/run-a",
      bareRepo: "/tmp/spg/git/cache/repo.git",
      baseRef: "refs/remotes/origin/main"
    }];
    await writeFile(graphPath, `${JSON.stringify(graph, null, 2)}\n`, "utf8");
    const payload = await buildVisualizerPayload(graphPath);
    assert.equal(payload.summary.totalNodes, 6);
    assert.deepEqual(payload.ready.map((node) => node.id), []);
    assert.deepEqual(payload.working.map((node) => node.id), ["A"]);
    assert.equal(payload.working[0].session, "codex-A");
    assert.equal(payload.working[0].isolation.cloneCwd, "/tmp/spg/workspaces/codex-A/A/run-a");
    assert.equal(payload.working[0].isolation.outputRef, "refs/heads/spg/node/A/run-a");
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
        blockedReason: '<img src=x onerror="blocked()">',
        failureReason: '<script>failed()</script><b>reason</b>',
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
      recentFailureReason: '<script>manager()</script><img src=x onerror=alert(1)>',
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
  assert.match(renderedHtml, /&lt;img src=x onerror=&quot;blocked\(\)&quot;&gt;/);
  assert.match(renderedHtml, /&lt;script&gt;failed\(\)&lt;\/script&gt;&lt;b&gt;reason&lt;\/b&gt;/);
  assert.match(renderedHtml, /\[truncated from 1027 chars\]/);
  assert.doesNotMatch(renderedHtml, /output\(\)/);
  assert.doesNotMatch(renderedHtml, /blocked\(\)"/);
  assert.doesNotMatch(renderedHtml, /<script\b/);
  assert.doesNotMatch(renderedHtml, /<img\b/);

  assert.match(element("worker-manager-summary").textContent, /<script>manager\(\)<\/script><img src=x onerror=alert\(1\)>/);
  assert.equal(element("worker-manager-summary").innerHTML, "");

  context.showRouteError("Worker start failed", new Error('<img src=x onerror=alert(1)><script>route()</script>'));
  assert.match(element("subtitle").textContent, /Worker start failed: <img src=x onerror=alert\(1\)><script>route\(\)<\/script>/);
  assert.equal(element("subtitle").innerHTML, "");
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
