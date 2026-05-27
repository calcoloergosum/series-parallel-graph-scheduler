import test from "node:test";
import {
  assert,
  blockNode,
  claimNode,
  completeNode,
  fixtureGraph,
  installGraphIoFaultInjectorForTests,
  join,
  listReadyLeafNodes,
  lockArtifacts,
  mkdir,
  readFile,
  readGraph,
  releaseExpiredLeases,
  renderPlanAfterUpdate,
  renderRaceGraph,
  rendererDocumentFixture,
  readdir,
  tmpdir,
  mkdtemp,
  rm,
  withTempGraph,
  writeFile,
  writeGraphAtomic
} from "./helpers/plan-scheduler-harness.mjs";

test("regression: failed atomic write during temp creation leaves existing graph intact", async () => {
  await withTempGraph(async (graphPath, dir) => {
    const before = await readFile(graphPath, "utf8");
    const restoreFaultInjector = installGraphIoFaultInjectorForTests((point) => {
      if (point === "before-atomic-temp-open") {
        throw new Error("injected temp file creation failure");
      }
    });

    try {
      const graph = fixtureGraph();
      graph.graphVersion = 99;
      await assert.rejects(() => writeGraphAtomic(graph, graphPath), /injected temp file creation failure/);
    } finally {
      restoreFaultInjector();
    }

    assert.equal(await readFile(graphPath, "utf8"), before);
    assert.equal((await readGraph(graphPath)).graphVersion, 1);
    assert.deepEqual(await lockArtifacts(dir), []);
  });
});

test("regression: failed atomic write during fsync removes partial temp files", async () => {
  await withTempGraph(async (graphPath, dir) => {
    const before = await readFile(graphPath, "utf8");
    const restoreFaultInjector = installGraphIoFaultInjectorForTests((point) => {
      if (point === "before-atomic-file-sync") {
        throw new Error("injected fsync failure");
      }
    });

    try {
      const graph = fixtureGraph();
      graph.graphVersion = 100;
      await assert.rejects(() => writeGraphAtomic(graph, graphPath), /injected fsync failure/);
    } finally {
      restoreFaultInjector();
    }

    assert.equal(await readFile(graphPath, "utf8"), before);
    assert.equal((await readGraph(graphPath)).graphVersion, 1);
    assert.deepEqual(await lockArtifacts(dir), []);
  });
});

test("regression: failed atomic write during rename preserves graph and cleans temp files", async () => {
  await withTempGraph(async (graphPath, dir) => {
    const before = await readFile(graphPath, "utf8");
    const restoreFaultInjector = installGraphIoFaultInjectorForTests((point) => {
      if (point === "before-atomic-rename") {
        throw new Error("injected rename failure");
      }
    });

    try {
      const graph = fixtureGraph();
      graph.graphVersion = 101;
      await assert.rejects(() => writeGraphAtomic(graph, graphPath), /injected rename failure/);
    } finally {
      restoreFaultInjector();
    }

    assert.equal(await readFile(graphPath, "utf8"), before);
    assert.equal((await readGraph(graphPath)).graphVersion, 1);
    assert.deepEqual(await lockArtifacts(dir), []);
  });
});

test("regression: atomic replacement failure leaves no graph temp files", async () => {
  const dir = await mkdtemp(join(tmpdir(), "plan-atomic-failure-"));
  const targetPath = join(dir, "target.graph.json");
  await mkdir(targetPath);

  try {
    await assert.rejects(() => writeGraphAtomic(fixtureGraph(), targetPath));
    assert.deepEqual((await readdir(dir)).filter((entry) => entry.endsWith(".tmp")), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("regression: failed render after graph update leaves graph readable and temp-free", async () => {
  await withTempGraph(async (graphPath, dir) => {
    const graph = await readGraph(graphPath);
    graph.document = rendererDocumentFixture();
    graph.scheduler = { htmlView: "html-output" };
    await writeFile(graphPath, `${JSON.stringify(graph, null, 2)}\n`, "utf8");
    await mkdir(join(dir, "html-output"));

    const claim = await claimNode(graphPath, { session: "codex-render-test" });
    assert.equal(claim.nodeId, "A");
    await assert.rejects(() => renderPlanAfterUpdate(graphPath), /render-plan exited with 1/);

    const content = await readFile(graphPath, "utf8");
    assert.ok(content.endsWith("\n"));
    const updated = await readGraph(graphPath);
    assert.equal(updated.graph.nodes.A.status, "claimed");
    assert.deepEqual(await lockArtifacts(dir), []);
  });
});

test("regression: concurrent render-after-update pipelines keep every claimed node", async () => {
  await withTempGraph(async (graphPath, dir) => {
    await writeFile(graphPath, `${JSON.stringify(renderRaceGraph(), null, 2)}\n`, "utf8");

    const updatedNodeIds = ["R1", "R2", "R3", "R4"];
    await Promise.all(updatedNodeIds.map(async (nodeId, index) => {
      await claimNode(graphPath, { nodeId, session: `render-worker-${index}` });
      await renderPlanAfterUpdate(graphPath);
    }));

    const graph = await readGraph(graphPath);
    assert.equal(graph.graphVersion, 5);
    for (const nodeId of updatedNodeIds) {
      assert.equal(graph.graph.nodes[nodeId].status, "claimed", nodeId);
      assert.equal(typeof graph.graph.nodes[nodeId].lease?.runId, "string", nodeId);
    }

    const html = await readFile(join(dir, "plan.html"), "utf8");
    assert.match(html, /Concurrent Render Regression Plan/);
    for (const nodeId of updatedNodeIds) {
      assert.match(html, new RegExp(`class="sp-node status-claimed" data-id="${nodeId}"`));
    }
    assert.deepEqual(await lockArtifacts(dir), []);
  });
});

test("regression: blocked parallel work does not hide ready sibling work", async () => {
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

test("regression: new claim reaps expired worker lease before selecting work", async () => {
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
    assert.ok(reclaimed.graph.nodes.A.history.some((entry) => entry.event === "expired"));
  });
});

test("regression: explicitly releasing expired leases makes work ready again", async () => {
  await withTempGraph(async (graphPath) => {
    await claimNode(graphPath, { session: "codex-A", leaseSeconds: 1 });
    const result = await releaseExpiredLeases(graphPath, new Date(Date.now() + 2000));
    assert.deepEqual(result.released, ["A"]);

    const graph = await readGraph(graphPath);
    assert.equal(graph.graph.nodes.A.status, "pending");
    assert.deepEqual(listReadyLeafNodes(graph).map((node) => node.id), ["A"]);
  });
});
