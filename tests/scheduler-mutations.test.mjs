import test from "node:test";
<<<<<<< Updated upstream
import { addUnknownMetadata, answerNode, assert, assertUnknownMetadata, blockNode, checkSchedulerTransitionReference, claimNode, completeNode, completedDeepReadinessGraph, concurrentMutationGraph, decomposeNode, deepReadinessGraph, diagnoseGraph, dirname, escapeRegExp, execFileAsync, failNode, knownTransitionStatuses, lastHistory, listReadyLeafNodes, listWorkingNodes, lockArtifacts, mutationOwnershipDocsPath, nestedResetReachabilityGraph, readGraph, readyIds, reconcileGraphStatus, releaseExpiredLeases, renewNodeLease, resetNode, resetReachable, resetSubtree, schedulerScriptPath, schedulerTransitionTable, setNodeStatus, startNode, stressScriptPath, withTempGraph, writeFile } from "./helpers/plan-scheduler-harness.mjs";
=======
import { addUnknownMetadata, answerNode, assert, assertUnknownMetadata, attachReadyPriorityFields, blockNode, buildReachableParentMap, buildReadyPrioritySelections, buildStableRootPathMap, buildVisualizerPayload, buildWorkerPrompt, checkSchedulerTransitionReference, claimNode, compareReadyPriorityCandidates, completeNode, completedDeepReadinessGraph, concurrentMutationGraph, countSharedParentsWithCurrentTask, decomposeNode, deepReadinessGraph, depthPriorityGraph, diagnoseGraph, dirname, escapeRegExp, execFileAsync, failNode, knownTransitionStatuses, lastHistory, leafOnlyChildCountPriorityGraph, listReadyLeafNodes, listWorkingNodes, lockArtifacts, mutationOwnershipDocsPath, nestedResetReachabilityGraph, readGraph, readyIds, reconcileGraphStatus, releaseExpiredLeases, renewNodeLease, resetNode, resetReachable, resetSubtree, schedulerScriptPath, schedulerTransitionTable, setNodeStatus, sharedParentPriorityGraph, startNode, stressScriptPath, validatePlanGraphFileResult, withTempGraph, writeFile } from "./helpers/plan-scheduler-harness.mjs";

function priorityCandidate(id, depth, childCount, sharedParentCountWithCurrentTask) {
  return {
    id,
    depth,
    child_count: childCount,
    shared_parent_count_with_current_task: sharedParentCountWithCurrentTask
  };
}

function priorityClaimGraph(activeNodes = []) {
  const activeNodeSet = new Set(activeNodes);
  const leasedCurrentNode = (title, session) => ({
    title,
    kind: "task",
    status: "running",
    lease: {
      session,
      runId: `run-${title}`,
      claimedAt: "2026-05-27T00:00:00.000Z",
      expiresAt: "2099-05-27T01:00:00.000Z"
    }
  });

  return {
    graphVersion: 1,
    title: "Priority Claim Context Test Graph",
    graph: {
      root: "ROOT",
      nodes: {
        ROOT: { title: "Root", kind: "parallel", status: "pending", children: ["P2", "P1"] },
        P1: { title: "Branch P1", kind: "parallel", status: "pending", children: ["CUR_P1", "A_TARGET"] },
        P2: { title: "Branch P2", kind: "parallel", status: "pending", children: ["CUR_P2", "B_TARGET"] },
        CUR_P1: activeNodeSet.has("CUR_P1")
          ? leasedCurrentNode("Current P1", "codex-A")
          : { title: "Inactive P1 current", kind: "task", status: "done" },
        CUR_P2: activeNodeSet.has("CUR_P2")
          ? leasedCurrentNode("Current P2", "codex-A")
          : { title: "Inactive P2 current", kind: "task", status: "done" },
        A_TARGET: { title: "Target A", kind: "task", status: "pending" },
        B_TARGET: { title: "Target B", kind: "task", status: "pending" }
      }
    }
  };
}

function activateSharedParentCurrent(graph, session = "codex-A") {
  graph.graph.nodes.CURRENT.status = "running";
  graph.graph.nodes.CURRENT.lease = {
    session,
    runId: "run-current",
    claimedAt: "2026-05-27T00:00:00.000Z",
    expiresAt: "2099-05-27T01:00:00.000Z"
  };
  return graph;
}

function cloneGraph(graph) {
  return JSON.parse(JSON.stringify(graph));
}

function reorderGraphNodes(graph, nodeOrder) {
  const remaining = { ...graph.graph.nodes };
  graph.graph.nodes = {};
  for (const nodeId of nodeOrder) {
    graph.graph.nodes[nodeId] = remaining[nodeId];
    delete remaining[nodeId];
  }
  for (const [nodeId, node] of Object.entries(remaining).reverse()) {
    graph.graph.nodes[nodeId] = node;
  }
  return graph;
}

test("ready priority comparator gives lower depth precedence over child count and shared parent count", () => {
  const sorted = [
    priorityCandidate("DEEPER_BIGGER", 3, 99, 0),
    priorityCandidate("SHALLOW_SMALLER", 2, 0, 50)
  ].sort(compareReadyPriorityCandidates);

  assert.deepEqual(sorted.map((candidate) => candidate.id), ["SHALLOW_SMALLER", "DEEPER_BIGGER"]);
});

test("ready priority comparator gives higher child_count precedence when depth ties", () => {
  const sorted = [
    priorityCandidate("LOW_FANOUT", 2, 1, 0),
    priorityCandidate("HIGH_FANOUT", 2, 4, 99)
  ].sort(compareReadyPriorityCandidates);

  assert.deepEqual(sorted.map((candidate) => candidate.id), ["HIGH_FANOUT", "LOW_FANOUT"]);
});

test("ready priority comparator gives lower shared_parent_count_with_current_task precedence when depth and child_count tie", () => {
  const sorted = [
    priorityCandidate("MORE_SHARED", 2, 3, 4),
    priorityCandidate("FEWER_SHARED", 2, 3, 1)
  ].sort(compareReadyPriorityCandidates);

  assert.deepEqual(sorted.map((candidate) => candidate.id), ["FEWER_SHARED", "MORE_SHARED"]);
});

test("ready priority comparator uses raw node id as the stable final tie-breaker across repeated runs", () => {
  const candidates = [
    priorityCandidate("node-10", 2, 0, 0),
    priorityCandidate("node-2", 2, 0, 0),
    priorityCandidate("node-01", 2, 0, 0)
  ];
  const orders = Array.from({ length: 20 }, (_, index) => {
    const rotated = candidates.slice(index % candidates.length).concat(candidates.slice(0, index % candidates.length));
    return rotated.sort(compareReadyPriorityCandidates).map((candidate) => candidate.id);
  });

  for (const order of orders) {
    assert.deepEqual(order, ["node-01", "node-10", "node-2"]);
  }
});

test("ready priority metadata exposes public fields while keeping parent sets internal", () => {
  const graph = sharedParentPriorityGraph();
  const ready = listReadyLeafNodes(graph);
  assert.deepEqual(ready.map((node) => ({
    id: node.id,
    depth: node.depth,
    child_count: node.child_count,
    shared_parent_count_with_current_task: node.shared_parent_count_with_current_task,
    parentSet: node.parentSet
  })), [
    {
      id: "A_NEAR",
      depth: 3,
      child_count: 0,
      shared_parent_count_with_current_task: 0,
      parentSet: undefined
    },
    {
      id: "B_MID",
      depth: 3,
      child_count: 0,
      shared_parent_count_with_current_task: 0,
      parentSet: undefined
    },
    {
      id: "ZZ_FAR_TIE",
      depth: 3,
      child_count: 0,
      shared_parent_count_with_current_task: 0,
      parentSet: undefined
    },
    {
      id: "Z_FAR",
      depth: 3,
      child_count: 0,
      shared_parent_count_with_current_task: 0,
      parentSet: undefined
    }
  ]);

  const selections = buildReadyPrioritySelections(graph, ready, "CURRENT");
  assert.deepEqual(Object.fromEntries(selections.map(({ priority }) => [
    priority.id,
    priority.shared_parent_count_with_current_task
  ])), {
    A_NEAR: 3,
    B_MID: 2,
    ZZ_FAR_TIE: 1,
    Z_FAR: 1
  });
  assert.equal(selections.some(({ priority }) => Object.hasOwn(priority, "parentSet")), false);
});

test("shared parent count helper treats missing current task context as an equal zero count", () => {
  const graph = sharedParentPriorityGraph();
  const pathMap = buildStableRootPathMap(graph);
  const candidateParentSet = new Set(pathMap.A_NEAR.slice(0, -1));

  assert.equal(countSharedParentsWithCurrentTask(candidateParentSet, pathMap), 0);
  assert.equal(countSharedParentsWithCurrentTask(candidateParentSet, pathMap, "MISSING"), 0);
  assert.equal(countSharedParentsWithCurrentTask(candidateParentSet, pathMap, "CURRENT"), 3);
});

test("automatic claim priority uses explicit current task id for shared-parent ranking", async () => {
  await withTempGraph(async (graphPath) => {
    const graph = sharedParentPriorityGraph();
    assert.equal(readyIds(graph)[0], "A_NEAR");
    await writeFile(graphPath, `${JSON.stringify(graph, null, 2)}\n`, "utf8");

    const claim = await claimNode(graphPath, { session: "codex-A", currentTaskId: graph.priorityFixture.currentTaskId });

    assert.equal(claim.nodeId, graph.priorityFixture.expectedWinner);
  });
});

test("automatic claim priority infers same-session current task for shared-parent ranking", async () => {
  await withTempGraph(async (graphPath) => {
    const graph = activateSharedParentCurrent(sharedParentPriorityGraph());
    await writeFile(graphPath, `${JSON.stringify(graph, null, 2)}\n`, "utf8");

    const claim = await claimNode(graphPath, { session: "codex-A" });

    assert.equal(claim.nodeId, graph.priorityFixture.expectedWinner);
  });
});

test("automatic claim priority falls back deterministically without current task context", async () => {
  await withTempGraph(async (graphPath) => {
    const graph = sharedParentPriorityGraph();
    await writeFile(graphPath, `${JSON.stringify(graph, null, 2)}\n`, "utf8");

    const claim = await claimNode(graphPath, { session: "codex-A" });

    assert.equal(claim.nodeId, graph.priorityFixture.fallbackWinner);
  });
});

test("shared-parent ranking tie-break is deterministic across graph node insertion orders", async () => {
  const fixture = sharedParentPriorityGraph();
  const variants = [
    fixture,
    reorderGraphNodes(cloneGraph(fixture), ["Z_FAR", "ZZ_FAR_TIE", "B_MID", "A_NEAR", "CURRENT", "FAR_GROUP", "OTHER", "RIGHT", "LEFT", "WORK", "ROOT"])
  ];

  for (const graph of variants) {
    await withTempGraph(async (graphPath) => {
      await writeFile(graphPath, `${JSON.stringify(graph, null, 2)}\n`, "utf8");

      const claim = await claimNode(graphPath, { session: "codex-A", currentTaskId: graph.priorityFixture.currentTaskId });

      assert.equal(claim.nodeId, graph.priorityFixture.tiedSharedParentWinner);
    });
  }
});

test("automatic claim priority uses explicit current task context when depth and child_count tie", async () => {
  await withTempGraph(async (graphPath) => {
    await writeFile(graphPath, `${JSON.stringify(priorityClaimGraph(), null, 2)}\n`, "utf8");

    const nearP1Claim = await claimNode(graphPath, { session: "codex-A", currentTaskId: "CUR_P1" });
    assert.equal(nearP1Claim.nodeId, "B_TARGET");
  });

  await withTempGraph(async (graphPath) => {
    await writeFile(graphPath, `${JSON.stringify(priorityClaimGraph(), null, 2)}\n`, "utf8");

    const nearP2Claim = await claimNode(graphPath, { session: "codex-A", currentTaskId: "CUR_P2" });
    assert.equal(nearP2Claim.nodeId, "A_TARGET");
  });
});

test("automatic claim priority infers exactly one active same-session current task", async () => {
  await withTempGraph(async (graphPath) => {
    await writeFile(graphPath, `${JSON.stringify(priorityClaimGraph(["CUR_P1"]), null, 2)}\n`, "utf8");

    const claim = await claimNode(graphPath, { session: "codex-A" });
    assert.equal(claim.nodeId, "B_TARGET");

    const graph = await readGraph(graphPath);
    assert.equal(graph.graph.nodes.CUR_P1.status, "running");
    assert.equal(graph.graph.nodes.CUR_P1.lease.session, "codex-A");
    assert.equal(graph.graph.nodes.B_TARGET.lease.session, "codex-A");
  });
});

test("automatic claim priority falls back without valid or unique current context", async () => {
  await withTempGraph(async (graphPath) => {
    await writeFile(graphPath, `${JSON.stringify(priorityClaimGraph(["CUR_P1", "CUR_P2"]), null, 2)}\n`, "utf8");

    const ambiguousClaim = await claimNode(graphPath, { session: "codex-A" });
    assert.equal(ambiguousClaim.nodeId, "A_TARGET");
  });

  await withTempGraph(async (graphPath) => {
    await writeFile(graphPath, `${JSON.stringify(priorityClaimGraph(), null, 2)}\n`, "utf8");

    const unknownCurrentTaskClaim = await claimNode(graphPath, { session: "codex-A", currentTaskId: "MISSING" });
    assert.equal(unknownCurrentTaskClaim.nodeId, "A_TARGET");
  });

  await withTempGraph(async (graphPath) => {
    await writeFile(graphPath, `${JSON.stringify(priorityClaimGraph(), null, 2)}\n`, "utf8");

    await assert.rejects(
      claimNode(graphPath, { session: "codex-A", currentTaskId: "" }),
      /Invalid explicit current task context: currentTaskId must be a non-empty string/
    );
  });
});

test("explicit node claim bypasses current task priority context", async () => {
  await withTempGraph(async (graphPath) => {
    await writeFile(graphPath, `${JSON.stringify(priorityClaimGraph(), null, 2)}\n`, "utf8");

    const claim = await claimNode(graphPath, {
      session: "codex-A",
      nodeId: "A_TARGET",
      currentTaskId: "CUR_P1"
    });
    assert.equal(claim.nodeId, "A_TARGET");
  });
});
>>>>>>> Stashed changes

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

test("readiness table covers deep series, parallel, gate, unknown kind, blocked, failed, and custom-status cases", () => {
  const cases = [
    {
      name: "first setup prerequisite only",
      statuses: {},
      ready: ["S1"]
    },
    {
      name: "second setup prerequisite after first is done",
      statuses: { S1: "done" },
      ready: ["S2"]
    },
    {
      name: "mixed fanout opens after setup is done",
      statuses: { SETUP: "done", S1: "done", S2: "done" },
      ready: ["CUSTOM_STATUS", "GATE_BRANCH", "L1", "R1", "R2", "U1", "U2"]
    },
    {
      name: "nested series branch withholds later leaf until prior leaf is done",
      statuses: { SETUP: "done", S1: "done", S2: "done", L1: "done" },
      ready: ["CUSTOM_STATUS", "GATE_BRANCH", "L2", "R1", "R2", "U1", "U2"]
    },
    {
      name: "final gate opens only after all parallel branches are terminal",
      statuses: {
        SETUP: "done",
        S1: "done",
        S2: "done",
        FANOUT: "done",
        LEFT: "done",
        L1: "done",
        L2: "done",
        RIGHT: "done",
        R1: "done",
        R2: "done",
        UNKNOWN_GROUP: "done",
        U1: "done",
        U2: "done",
        GATE_BRANCH: "done",
        BLOCKED_LEAF: "done",
        FAILED_LEAF: "done",
        CUSTOM_STATUS: "done"
      },
      ready: ["FINAL_GATE"]
    },
    {
      name: "post-gate work opens last",
      statuses: {
        SETUP: "done",
        S1: "done",
        S2: "done",
        FANOUT: "done",
        LEFT: "done",
        L1: "done",
        L2: "done",
        RIGHT: "done",
        R1: "done",
        R2: "done",
        UNKNOWN_GROUP: "done",
        U1: "done",
        U2: "done",
        GATE_BRANCH: "done",
        BLOCKED_LEAF: "done",
        FAILED_LEAF: "done",
        CUSTOM_STATUS: "done",
        FINAL_GATE: "done"
      },
      ready: ["AFTER"]
    }
  ];

  for (const { name, statuses, ready } of cases) {
    assert.deepEqual(readyIds(deepReadinessGraph(statuses)), ready, name);
  }
});

test("downstream series leaves never become ready before every prerequisite subtree is done", () => {
  const downstreamIds = new Set([
    "L1",
    "L2",
    "R1",
    "R2",
    "U1",
    "U2",
    "GATE_BRANCH",
    "CUSTOM_STATUS",
    "FINAL_GATE",
    "AFTER"
  ]);
  const prerequisiteStates = [
    {},
    { S1: "done" },
    { SETUP: "done", S1: "done", S2: "done" },
    { SETUP: "done", S1: "done", S2: "done", FANOUT: "done", LEFT: "done", L1: "done", L2: "done", RIGHT: "done", R1: "done", R2: "done", UNKNOWN_GROUP: "done", U1: "done", U2: "done", GATE_BRANCH: "done", BLOCKED_LEAF: "done", FAILED_LEAF: "done", CUSTOM_STATUS: "done" }
  ];

  assert.deepEqual(readyIds(deepReadinessGraph(prerequisiteStates[0])), ["S1"]);
  assert.deepEqual(readyIds(deepReadinessGraph(prerequisiteStates[1])), ["S2"]);

  const fanoutReady = readyIds(deepReadinessGraph(prerequisiteStates[2]));
  assert.deepEqual(fanoutReady, ["CUSTOM_STATUS", "GATE_BRANCH", "L1", "R1", "R2", "U1", "U2"]);
  assert.equal(fanoutReady.some((nodeId) => ["FINAL_GATE", "AFTER"].includes(nodeId)), false);

  const gateReady = readyIds(deepReadinessGraph(prerequisiteStates[3]));
  assert.deepEqual(gateReady, ["FINAL_GATE"]);
  assert.equal(gateReady.some((nodeId) => downstreamIds.has(nodeId) && nodeId !== "FINAL_GATE"), false);
});

test("priority metadata covers mixed shallow and deep ready leaves without changing readiness", () => {
  const graph = deepReadinessGraph({ SETUP: "done", S1: "done", S2: "done" });
  const ready = listReadyLeafNodes(graph);

  assert.deepEqual(
    ready.map((node) => ({
      id: node.id,
      kind: node.kind,
      status: node.status,
      depth: node.depth,
      child_count: node.child_count,
      shared_parent_count_with_current_task: node.shared_parent_count_with_current_task
    })),
    [
      { id: "CUSTOM_STATUS", kind: "task", status: "waiting-for-signal", depth: 2, child_count: 0, shared_parent_count_with_current_task: 0 },
      { id: "GATE_BRANCH", kind: "gate", status: "pending", depth: 2, child_count: 0, shared_parent_count_with_current_task: 0 },
      { id: "L1", kind: "task", status: "pending", depth: 3, child_count: 0, shared_parent_count_with_current_task: 0 },
      { id: "R1", kind: "task", status: "pending", depth: 3, child_count: 0, shared_parent_count_with_current_task: 0 },
      { id: "R2", kind: "task", status: "pending", depth: 3, child_count: 0, shared_parent_count_with_current_task: 0 },
      { id: "U1", kind: "task", status: "pending", depth: 3, child_count: 0, shared_parent_count_with_current_task: 0 },
      { id: "U2", kind: "task", status: "pending", depth: 3, child_count: 0, shared_parent_count_with_current_task: 0 }
    ]
  );
  assert.equal(ready.some((node) => ["FANOUT", "LEFT", "RIGHT", "UNKNOWN_GROUP"].includes(node.id)), false);
});

test("priority metadata scores supplied internal candidates without making internal nodes ready", () => {
  const graph = leafOnlyChildCountPriorityGraph();
  const ready = listReadyLeafNodes(graph);

  assert.deepEqual(ready.map((node) => node.id), ["A_NO_CHILDREN", "B_EMPTY_CHILDREN"]);
  assert.equal(ready.some((node) => node.id === "WIDE_INTERNAL"), false);

  const scored = attachReadyPriorityFields(graph, [
    ...ready,
    {
      id: "WIDE_INTERNAL",
      title: graph.graph.nodes.WIDE_INTERNAL.title,
      kind: "parallel",
      status: "pending"
    }
  ]);
  const internal = scored.find((node) => node.id === "WIDE_INTERNAL");

  assert.deepEqual(
    {
      id: internal.id,
      depth: internal.depth,
      child_count: internal.child_count,
      shared_parent_count_with_current_task: internal.shared_parent_count_with_current_task
    },
    {
      id: "WIDE_INTERNAL",
      depth: 1,
      child_count: 3,
      shared_parent_count_with_current_task: 0
    }
  );
  assert.deepEqual(listReadyLeafNodes(graph).map((node) => node.id), ["A_NO_CHILDREN", "B_EMPTY_CHILDREN"]);
});

test("priority metadata uses one stable root path for shared-parent DAG candidates", () => {
  const graph = {
    graphVersion: 1,
    title: "Shared Parent Metadata Edge Case",
    graph: {
      root: "ROOT",
      nodes: {
        ROOT: { title: "Root", kind: "parallel", status: "pending", children: ["B_SIDE", "A_SIDE"] },
        A_SIDE: { title: "Lexically first parent", kind: "parallel", status: "pending", children: ["SHARED_READY"] },
        B_SIDE: { title: "Current task parent", kind: "parallel", status: "pending", children: ["CURRENT", "SHARED_READY"] },
        CURRENT: { title: "Current task", kind: "task", status: "running" },
        SHARED_READY: { title: "Shared ready task", kind: "task", status: "pending" }
      }
    }
  };

  assert.deepEqual(buildReachableParentMap(graph).SHARED_READY, ["A_SIDE", "B_SIDE"]);
  assert.deepEqual(buildStableRootPathMap(graph).SHARED_READY, ["ROOT", "A_SIDE", "SHARED_READY"]);

  const [{ priority }] = buildReadyPrioritySelections(
    graph,
    [{ id: "SHARED_READY", title: "Shared ready task", kind: "task", status: "pending" }],
    "CURRENT"
  );

  assert.deepEqual(priority, {
    id: "SHARED_READY",
    depth: 2,
    child_count: 0,
    shared_parent_count_with_current_task: 1
  });
});

test("ready command rejects invalid graphs before priority metadata traversal", async () => {
  await withTempGraph(async (graphPath) => {
    const graph = {
      graphVersion: 1,
      title: "Invalid Priority Metadata Fixture",
      graph: {
        root: "ROOT",
        nodes: {
          ROOT: { title: "Root", kind: "series", status: "pending", children: ["A"] },
          A: { title: "Cycle", kind: "series", status: "pending", children: ["ROOT"] }
        }
      }
    };

    const validation = validatePlanGraphFileResult(graph);
    assert.match(validation.errors.map((issue) => issue.message).join("\n"), /Cycle detected: ROOT -> A -> ROOT/);
    await writeFile(graphPath, `${JSON.stringify(graph, null, 2)}\n`, "utf8");

    await assert.rejects(
      execFileAsync(process.execPath, [schedulerScriptPath, "ready", "--graph", graphPath]),
      (error) => {
        assert.match(error.stderr, /Invalid graph file/);
        assert.match(error.stderr, /Cycle detected: ROOT -> A -> ROOT/);
        assert.doesNotMatch(error.stderr, /Cycle detected in graph/);
        assert.equal(error.stdout, "");
        return true;
      }
    );
  });
});

test("priority fixture builders isolate depth, child-count, and shared-parent cases", () => {
  const depth = depthPriorityGraph();
  assert.deepEqual(readyIds(depth), ["Z_SHALLOW", "A_DEEP"]);
  assert.equal(depth.priorityFixture.traversalFirst, "A_DEEP");
  assert.equal(depth.priorityFixture.expectedWinner, "Z_SHALLOW");

  const childCount = leafOnlyChildCountPriorityGraph();
  assert.deepEqual(readyIds(childCount), ["A_NO_CHILDREN", "B_EMPTY_CHILDREN"]);
  assert.equal(childCount.priorityFixture.contract, "leaf-only");
  assert.equal(childCount.priorityFixture.expectedWinner, "A_NO_CHILDREN");
  assert.equal(childCount.graph.nodes.WIDE_INTERNAL.children.length, 3);

  const sharedParent = sharedParentPriorityGraph();
  assert.deepEqual(readyIds(sharedParent), ["A_NEAR", "B_MID", "ZZ_FAR_TIE", "Z_FAR"]);
  assert.equal(sharedParent.priorityFixture.currentTaskId, "CURRENT");
  assert.equal(sharedParent.priorityFixture.expectedWinner, "ZZ_FAR_TIE");
  assert.equal(sharedParent.priorityFixture.fallbackWinner, "A_NEAR");
  assert.equal(sharedParent.priorityFixture.tiedSharedParentWinner, "ZZ_FAR_TIE");
});

test("read-only ready surfaces expose priority order and metadata consistently", async () => {
  await withTempGraph(async (graphPath, dir) => {
    const graph = depthPriorityGraph();
    await writeFile(graphPath, `${JSON.stringify(graph, null, 2)}\n`, "utf8");

    const assertPriorityReady = (ready) => {
      assert.deepEqual(ready.map((node) => node.id), ["Z_SHALLOW", "A_DEEP"]);
      assert.deepEqual(
        ready.map((node) => ({
          id: node.id,
          depth: node.depth,
          child_count: node.child_count,
          shared_parent_count_with_current_task: node.shared_parent_count_with_current_task
        })),
        [
          { id: "Z_SHALLOW", depth: 1, child_count: 0, shared_parent_count_with_current_task: 0 },
          { id: "A_DEEP", depth: 2, child_count: 0, shared_parent_count_with_current_task: 0 }
        ]
      );
    };

    const cliReady = await execFileAsync(process.execPath, [schedulerScriptPath, "ready", "--graph", graphPath]);
    assertPriorityReady(JSON.parse(cliReady.stdout));

    const diagnostics = await diagnoseGraph(graphPath);
    assertPriorityReady(diagnostics.nextReady);

    const visualizerPayload = await buildVisualizerPayload(graphPath);
    assertPriorityReady(visualizerPayload.ready);

    const templatePath = `${dir}/ready-template.md`;
    await writeFile(templatePath, "{{readyJson}}", "utf8");
    const promptReady = JSON.parse(await buildWorkerPrompt(graphPath, {
      nodeId: "A_DEEP",
      session: "codex-A",
      runId: "run-test",
      templatePath
    }));
    assertPriorityReady(promptReady);
  });
});

test("automatic claim uses priority ordering instead of traversal order", async () => {
  await withTempGraph(async (graphPath) => {
    const graph = depthPriorityGraph();
    await writeFile(graphPath, `${JSON.stringify(graph, null, 2)}\n`, "utf8");

    const claim = await claimNode(graphPath, { session: "priority-auto" });

    assert.equal(claim.nodeId, graph.priorityFixture.expectedWinner);
    assert.equal(claim.title, graph.graph.nodes.Z_SHALLOW.title);
    assert.equal(claim.lease.session, "priority-auto");
    assert.equal(claim.releasedExpired.length, 0);
    assert.equal(claim.summary.counts.claimed, 1);

    const updated = await readGraph(graphPath);
    assert.equal(updated.graphVersion, 2);
    assert.equal(updated.graph.nodes.Z_SHALLOW.status, "claimed");
    assert.deepEqual(updated.graph.nodes.Z_SHALLOW.lease, claim.lease);
    assert.equal(updated.graph.nodes.Z_SHALLOW.history.at(-1).event, "claimed");
    assert.equal(updated.graph.nodes.Z_SHALLOW.history.at(-1).runId, claim.runId);
    assert.equal(updated.graph.nodes.Z_SHALLOW.history.at(-1).leaseExpiresAt, claim.lease.expiresAt);
    assert.equal(updated.graph.nodes.A_DEEP.status, "pending");
    assert.equal(updated.graph.nodes.A_DEEP.lease, undefined);
  });
});

test("explicit claim by node id does not rerank to a higher-priority ready node", async () => {
  await withTempGraph(async (graphPath) => {
    const graph = depthPriorityGraph();
    await writeFile(graphPath, `${JSON.stringify(graph, null, 2)}\n`, "utf8");

    const claim = await claimNode(graphPath, { session: "priority-explicit", nodeId: graph.priorityFixture.traversalFirst });

    assert.equal(claim.nodeId, graph.priorityFixture.traversalFirst);
    assert.equal(claim.lease.session, "priority-explicit");
    const updated = await readGraph(graphPath);
    assert.equal(updated.graphVersion, 2);
    assert.equal(updated.graph.nodes.A_DEEP.status, "claimed");
    assert.deepEqual(updated.graph.nodes.A_DEEP.lease, claim.lease);
    assert.equal(updated.graph.nodes.A_DEEP.history.at(-1).runId, claim.runId);
    assert.equal(updated.graph.nodes.Z_SHALLOW.status, "pending");
    assert.equal(updated.graph.nodes.Z_SHALLOW.lease, undefined);
  });
});

test("claim releases expired leases before priority selection", async () => {
  await withTempGraph(async (graphPath) => {
    const graph = {
      graphVersion: 1,
      title: "Expired Lease Priority Fixture",
      graph: {
        root: "ROOT",
        nodes: {
          ROOT: { title: "Root", kind: "parallel", status: "pending", children: ["Z_READY", "A_EXPIRED"] },
          Z_READY: { title: "Traversal-first ready task", kind: "task", status: "pending" },
          A_EXPIRED: {
            title: "Expired task should re-enter ready set",
            kind: "task",
            status: "running",
            startedAt: "2026-05-27T00:00:00.000Z",
            lease: {
              session: "stale-worker",
              runId: "run-stale",
              claimedAt: "2026-05-27T00:00:00.000Z",
              expiresAt: "2026-05-27T00:00:01.000Z"
            }
          }
        }
      }
    };
    await writeFile(graphPath, `${JSON.stringify(graph, null, 2)}\n`, "utf8");

    const claim = await claimNode(graphPath, { session: "priority-expired" });

    assert.equal(claim.nodeId, "A_EXPIRED");
    assert.deepEqual(claim.releasedExpired, ["A_EXPIRED"]);
    assert.equal(claim.lease.session, "priority-expired");
    assert.equal(claim.summary.counts.claimed, 1);
    assert.equal(claim.summary.counts.pending, 2);

    const updated = await readGraph(graphPath);
    assert.equal(updated.graphVersion, 2);
    assert.equal(updated.graph.nodes.A_EXPIRED.status, "claimed");
    assert.equal(updated.graph.nodes.A_EXPIRED.startedAt, undefined);
    assert.deepEqual(updated.graph.nodes.A_EXPIRED.lease, claim.lease);
    assert.deepEqual(updated.graph.nodes.A_EXPIRED.history.map((entry) => entry.event), ["expired", "claimed"]);
    assert.equal(updated.graph.nodes.A_EXPIRED.history[0].session, "stale-worker");
    assert.equal(updated.graph.nodes.A_EXPIRED.history[0].runId, "run-stale");
    assert.equal(updated.graph.nodes.A_EXPIRED.history[0].leaseExpiresAt, "2026-05-27T00:00:01.000Z");
    assert.equal(updated.graph.nodes.A_EXPIRED.history[1].runId, claim.runId);
    assert.equal(updated.graph.nodes.A_EXPIRED.history[1].leaseExpiresAt, claim.lease.expiresAt);
    assert.equal(updated.graph.nodes.Z_READY.status, "pending");
    assert.equal(updated.graph.nodes.Z_READY.lease, undefined);
  });
});

test("concurrent priority automatic claims never return the same node id", async () => {
  await withTempGraph(async (graphPath) => {
    await writeFile(graphPath, `${JSON.stringify(depthPriorityGraph(), null, 2)}\n`, "utf8");

    const attempts = Array.from({ length: 8 }, (_, index) =>
      claimNode(graphPath, { session: `priority-parallel-${index}` })
    );
    const results = await Promise.allSettled(attempts);
    const claimed = results
      .filter((result) => result.status === "fulfilled")
      .map((result) => result.value.nodeId);
    const rejected = results.filter((result) => result.status === "rejected");

    assert.deepEqual([...claimed].sort(), ["A_DEEP", "Z_SHALLOW"]);
    assert.equal(new Set(claimed).size, claimed.length, `Duplicate priority claim detected for ${graphPath}`);
    assert.equal(rejected.length, 6);
    for (const result of rejected) {
      assert.match(result.reason.message, /No ready nodes to claim/);
    }

    const updated = await readGraph(graphPath);
    assert.equal(updated.graphVersion, 3);
    assert.equal(updated.graph.nodes.A_DEEP.status, "claimed");
    assert.equal(updated.graph.nodes.Z_SHALLOW.status, "claimed");
    assert.notEqual(updated.graph.nodes.A_DEEP.lease.runId, updated.graph.nodes.Z_SHALLOW.lease.runId);
  });
});

test("reconcile marks a completed deep mixed graph while preserving exact readiness before completion", async () => {
  await withTempGraph(async (graphPath) => {
    const graph = completedDeepReadinessGraph();
    graph.graph.nodes.ROOT.status = "pending";
    graph.graph.nodes.SETUP.status = "pending";
    graph.graph.nodes.FANOUT.status = "pending";
    graph.graph.nodes.LEFT.status = "pending";
    graph.graph.nodes.RIGHT.status = "pending";
    graph.graph.nodes.UNKNOWN_GROUP.status = "pending";
    await writeFile(graphPath, `${JSON.stringify(graph, null, 2)}\n`, "utf8");

    assert.deepEqual(readyIds(await readGraph(graphPath)), []);

    const result = await reconcileGraphStatus(graphPath);
    assert.deepEqual(result.changed.sort(), ["FANOUT", "LEFT", "RIGHT", "ROOT", "SETUP", "UNKNOWN_GROUP"]);

    const updated = await readGraph(graphPath);
    assert.equal(updated.graph.nodes.ROOT.status, "done");
    assert.equal(updated.graph.nodes.FANOUT.status, "done");
    assert.deepEqual(readyIds(updated), []);
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

test("concurrent lifecycle mutations preserve every serialized update", async () => {
  await withTempGraph(async (graphPath) => {
    await writeFile(graphPath, `${JSON.stringify(concurrentMutationGraph(), null, 2)}\n`, "utf8");

    const operations = [
      renewNodeLease(graphPath, {
        nodeId: "RENEW",
        session: "renew-owner",
        runId: "run-renew",
        leaseSeconds: 120
      }),
      releaseExpiredLeases(graphPath, new Date("2026-05-27T00:00:01.000Z")),
      completeNode(graphPath, {
        nodeId: "COMPLETE",
        session: "complete-owner",
        runId: "run-complete",
        report: "reports/complete.md"
      }),
      failNode(graphPath, {
        nodeId: "FAIL",
        session: "fail-owner",
        runId: "run-fail",
        reason: "regression failure",
        report: "reports/fail.md"
      }),
      resetNode(graphPath, { nodeId: "RESET", reason: "operator retry" }),
      decomposeNode(graphPath, {
        nodeId: "DECOMPOSE",
        session: "decompose-owner",
        runId: "run-decompose",
        kind: "series",
        children: [
          { id: "DECOMPOSE_1", title: "First decomposed child" },
          { id: "DECOMPOSE_2", title: "Second decomposed child" }
        ]
      })
    ];

    const results = await Promise.allSettled(operations);
    assert.deepEqual(results.map((result) => result.status), Array.from({ length: operations.length }, () => "fulfilled"));

    const graph = await readGraph(graphPath);
    assert.equal(graph.graphVersion, 7);
    assert.equal(graph.graph.nodes.RENEW.status, "running");
    assert.equal(graph.graph.nodes.RENEW.lease.session, "renew-owner");
    assert.ok(graph.graph.nodes.RENEW.lease.renewedAt);

    assert.equal(graph.graph.nodes.EXPIRE.status, "pending");
    assert.equal(graph.graph.nodes.EXPIRE.lease, undefined);
    assert.ok(graph.graph.nodes.EXPIRE.history.some((entry) => entry.event === "expired"));

    assert.equal(graph.graph.nodes.COMPLETE.status, "done");
    assert.equal(graph.graph.nodes.COMPLETE.report, "reports/complete.md");
    assert.equal(graph.graph.nodes.COMPLETE.lease, undefined);

    assert.equal(graph.graph.nodes.FAIL.status, "failed");
    assert.equal(graph.graph.nodes.FAIL.failureReason, "regression failure");
    assert.equal(graph.graph.nodes.FAIL.report, "reports/fail.md");
    assert.equal(graph.graph.nodes.FAIL.lease, undefined);

    assert.equal(graph.graph.nodes.RESET.status, "pending");
    assert.equal(graph.graph.nodes.RESET.report, undefined);
    assert.ok(graph.graph.nodes.RESET.history.some((entry) => entry.event === "reset" && entry.reason === "operator retry"));

    assert.equal(graph.graph.nodes.DECOMPOSE.status, "pending");
    assert.deepEqual(graph.graph.nodes.DECOMPOSE.children, ["DECOMPOSE_1", "DECOMPOSE_2"]);
    assert.equal(graph.graph.nodes.DECOMPOSE.lease, undefined);
    assert.equal(graph.graph.nodes.DECOMPOSE_1.status, "pending");
    assert.equal(graph.graph.nodes.DECOMPOSE_2.status, "pending");

    assert.deepEqual(await lockArtifacts(dirname(graphPath)), []);
  });
});

test("deterministic concurrency stress command runs seeded iterations", async () => {
  const result = await execFileAsync(process.execPath, [
    stressScriptPath,
    "--iterations",
    "3",
    "--seed",
    "4242"
  ]);

  assert.match(result.stdout, /deterministic concurrency stress passed: iterations=3 seed=4242/);
  assert.equal(result.stderr, "");
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

test("mutations preserve unknown metadata and record contextual history", async (t) => {
  await t.test("claim", async () => {
    await withTempGraph(async (graphPath) => {
      await addUnknownMetadata(graphPath);
      await claimNode(graphPath, { session: "codex-A", nodeId: "A" });

      const graph = await readGraph(graphPath);
      assertUnknownMetadata(graph);
      assert.deepEqual(lastHistory(graph.graph.nodes.A), {
        ...lastHistory(graph.graph.nodes.A),
        event: "claimed",
        previousStatus: "pending",
        status: "claimed",
        session: "codex-A"
      });
      assert.ok(lastHistory(graph.graph.nodes.A).runId);
      assert.ok(lastHistory(graph.graph.nodes.A).leaseExpiresAt);
    });
  });

  await t.test("start", async () => {
    await withTempGraph(async (graphPath) => {
      await addUnknownMetadata(graphPath);
      await claimNode(graphPath, { session: "codex-A", nodeId: "A" });
      await startNode(graphPath, { nodeId: "A", session: "codex-A" });

      const graph = await readGraph(graphPath);
      assertUnknownMetadata(graph);
      const entry = lastHistory(graph.graph.nodes.A);
      assert.equal(entry.event, "running");
      assert.equal(entry.previousStatus, "claimed");
      assert.equal(entry.status, "running");
      assert.equal(entry.session, "codex-A");
      assert.ok(entry.startedAt);
    });
  });

  await t.test("done", async () => {
    await withTempGraph(async (graphPath) => {
      await addUnknownMetadata(graphPath);
      await claimNode(graphPath, { session: "codex-A", nodeId: "A" });
      await completeNode(graphPath, { nodeId: "A", session: "codex-A", report: "reports/A.md" });

      const graph = await readGraph(graphPath);
      assertUnknownMetadata(graph);
      const entry = lastHistory(graph.graph.nodes.A);
      assert.equal(entry.event, "done");
      assert.equal(entry.previousStatus, "claimed");
      assert.equal(entry.status, "done");
      assert.equal(entry.report, "reports/A.md");
      assert.deepEqual(entry.clearedFields, ["lease", "blockedReason", "question"]);
    });
  });

  await t.test("block and answer", async () => {
    await withTempGraph(async (graphPath) => {
      await addUnknownMetadata(graphPath);
      await claimNode(graphPath, { session: "codex-A", nodeId: "A" });
      await blockNode(graphPath, {
        nodeId: "A",
        session: "codex-A",
        reason: "needs_scope",
        question: "Clarify scope?"
      });
      let graph = await readGraph(graphPath);
      assertUnknownMetadata(graph);
      let entry = lastHistory(graph.graph.nodes.A);
      assert.equal(entry.event, "blocked");
      assert.equal(entry.previousStatus, "claimed");
      assert.equal(entry.status, "blocked");
      assert.equal(entry.blockedReason, "needs_scope");
      assert.equal(entry.question, "Clarify scope?");

      await answerNode(graphPath, { nodeId: "A", answer: "Use current scope.", responder: "operator" });
      graph = await readGraph(graphPath);
      assertUnknownMetadata(graph);
      entry = lastHistory(graph.graph.nodes.A);
      assert.equal(entry.event, "answered");
      assert.equal(entry.previousStatus, "blocked");
      assert.equal(entry.status, "pending");
      assert.equal(entry.answer, "Use current scope.");
      assert.equal(entry.responder, "operator");
      assert.deepEqual(entry.clearedFields, ["lease"]);
    });
  });

  await t.test("fail", async () => {
    await withTempGraph(async (graphPath) => {
      await addUnknownMetadata(graphPath);
      await claimNode(graphPath, { session: "codex-A", nodeId: "A" });
      await failNode(graphPath, {
        nodeId: "A",
        session: "codex-A",
        reason: "test failure",
        report: "reports/A.md"
      });

      const graph = await readGraph(graphPath);
      assertUnknownMetadata(graph);
      const entry = lastHistory(graph.graph.nodes.A);
      assert.equal(entry.event, "failed");
      assert.equal(entry.previousStatus, "claimed");
      assert.equal(entry.status, "failed");
      assert.equal(entry.failureReason, "test failure");
      assert.equal(entry.report, "reports/A.md");
      assert.deepEqual(entry.clearedFields, ["lease"]);
    });
  });

  await t.test("reset", async () => {
    await withTempGraph(async (graphPath) => {
      await addUnknownMetadata(graphPath);
      await claimNode(graphPath, { session: "codex-A", nodeId: "A" });
      await completeNode(graphPath, { nodeId: "A", session: "codex-A", report: "reports/A.md" });
      await resetNode(graphPath, { nodeId: "A", reason: "retry" });

      const graph = await readGraph(graphPath);
      assertUnknownMetadata(graph);
      const entry = lastHistory(graph.graph.nodes.A);
      assert.equal(entry.event, "reset");
      assert.equal(entry.previousStatus, "done");
      assert.equal(entry.status, "pending");
      assert.equal(entry.resetScope, "node");
      assert.equal(entry.reason, "retry");
      assert.ok(entry.clearedFields.includes("report"));
      assert.ok(entry.clearedFields.includes("lease"));
    });
  });

  await t.test("reset-subtree and reset-reachable", async () => {
    await withTempGraph(async (graphPath) => {
      await addUnknownMetadata(graphPath);
      await claimNode(graphPath, { session: "codex-A", nodeId: "A" });
      await completeNode(graphPath, { nodeId: "A", session: "codex-A" });
      await claimNode(graphPath, { session: "codex-B", nodeId: "B" });
      await resetSubtree(graphPath, { nodeId: "P", reason: "retry branch" });

      let graph = await readGraph(graphPath);
      assertUnknownMetadata(graph, "B");
      let entry = lastHistory(graph.graph.nodes.B);
      assert.equal(entry.event, "reset");
      assert.equal(entry.previousStatus, "claimed");
      assert.equal(entry.status, "pending");
      assert.equal(entry.resetScope, "subtree");
      assert.equal(entry.rootId, "P");
      assert.ok(entry.clearedFields.includes("lease"));

      await claimNode(graphPath, { session: "codex-B2", nodeId: "B" });
      await completeNode(graphPath, { nodeId: "B", session: "codex-B2" });
      await claimNode(graphPath, { session: "codex-C", nodeId: "C" });
      await completeNode(graphPath, { nodeId: "C", session: "codex-C" });
      await claimNode(graphPath, { session: "codex-G", nodeId: "G" });
      await resetReachable(graphPath, { nodeId: "B", reason: "retry downstream" });

      graph = await readGraph(graphPath);
      assertUnknownMetadata(graph, "G");
      entry = lastHistory(graph.graph.nodes.G);
      assert.equal(entry.event, "reset");
      assert.equal(entry.previousStatus, "claimed");
      assert.equal(entry.status, "pending");
      assert.equal(entry.resetScope, "reachable");
      assert.equal(entry.rootId, "B");
      assert.ok(entry.clearedFields.includes("lease"));
    });
  });

  await t.test("decompose", async () => {
    await withTempGraph(async (graphPath) => {
      await addUnknownMetadata(graphPath);
      await claimNode(graphPath, { session: "codex-A", nodeId: "A" });
      await decomposeNode(graphPath, {
        nodeId: "A",
        session: "codex-A",
        kind: "series",
        children: [
          { id: "A1", title: "First child", ownerMetadata: { retained: true } },
          { id: "A2", title: "Second child" }
        ]
      });

      const graph = await readGraph(graphPath);
      assertUnknownMetadata(graph);
      assert.deepEqual(graph.graph.nodes.A1.ownerMetadata, { retained: true });
      const entry = lastHistory(graph.graph.nodes.A);
      assert.equal(entry.event, "decomposed");
      assert.equal(entry.previousStatus, "claimed");
      assert.equal(entry.status, "pending");
      assert.deepEqual(entry.childIds, ["A1", "A2"]);
      assert.ok(entry.clearedFields.includes("lease"));
    });
  });

  await t.test("reconcile", async () => {
    await withTempGraph(async (graphPath) => {
      await addUnknownMetadata(graphPath);
      for (const nodeId of ["A", "B", "C", "G"]) {
        await setNodeStatus(graphPath, nodeId, "done");
      }
      await reconcileGraphStatus(graphPath);

      const graph = await readGraph(graphPath);
      assertUnknownMetadata(graph, "P");
      const entry = lastHistory(graph.graph.nodes.P);
      assert.equal(entry.event, "subtree-done");
      assert.equal(entry.previousStatus, "pending");
      assert.equal(entry.status, "done");
      assert.deepEqual(entry.childIds, ["B", "C"]);
    });
  });
});

test("scheduler transition table documents mutating commands and actors", () => {
  assert.deepEqual(Object.keys(schedulerTransitionTable).sort(), [
    "answer",
    "block",
    "claim",
    "decompose",
    "done",
    "fail",
    "reconcile",
    "release-expired",
    "renew",
    "reset",
    "reset-reachable",
    "reset-subtree",
    "start"
  ].sort());
  assert.equal(schedulerTransitionTable.start.actor, "worker");
  assert.equal(schedulerTransitionTable.done.implementation, "completeNode");
  assert.equal(schedulerTransitionTable.answer.actor, "operator");
  assert.equal(schedulerTransitionTable.claim.additionalAllowedFrom, "custom non-busy, non-terminal leaf statuses");
  assert.equal(schedulerTransitionTable.reset.lease.includes("clears any lease"), true);
  assert.equal(schedulerTransitionTable["reset-reachable"].additionalAllowedFrom, "custom statuses");
  assert.equal(schedulerTransitionTable["release-expired"].actor, "system");
});

test("mutation ownership docs render scheduler transition table from source", async () => {
  await checkSchedulerTransitionReference(mutationOwnershipDocsPath);
});

test("transition contract covers every known status for every mutating command", async (t) => {
  const leafCommandCases = [
    {
      command: "claim",
      target: "claimed",
      run: (graphPath) => claimNode(graphPath, { session: "owner", nodeId: "A" }),
      rejects: /Node is not ready to claim/,
      shouldMutate: (status) => status === "pending"
    },
    {
      command: "start",
      target: "running",
      run: (graphPath) => startNode(graphPath, { nodeId: "A", session: "owner" }),
      rejects: /Cannot start node from status/
    },
    {
      command: "renew",
      target: "same",
      run: (graphPath) => renewNodeLease(graphPath, { nodeId: "A", session: "owner", leaseSeconds: 5 }),
      rejects: /Cannot renew node from status/,
      requiresLease: true
    },
    {
      command: "done",
      target: "done",
      run: (graphPath) => completeNode(graphPath, { nodeId: "A", session: "owner" }),
      rejects: /Cannot complete node from status/
    },
    {
      command: "block",
      target: "blocked",
      run: (graphPath) => blockNode(graphPath, { nodeId: "A", session: "owner", question: "Proceed?" }),
      rejects: /Cannot block node from status/
    },
    {
      command: "answer",
      target: "pending",
      run: (graphPath) => answerNode(graphPath, { nodeId: "A", answer: "Proceed.", responder: "operator" }),
      rejects: /Cannot answer node from status/
    },
    {
      command: "fail",
      target: "failed",
      run: (graphPath) => failNode(graphPath, { nodeId: "A", session: "owner", reason: "test" }),
      rejects: /Cannot fail node from status/
    },
    {
      command: "reset",
      target: "pending",
      run: (graphPath) => resetNode(graphPath, { nodeId: "A", reason: "test reset" })
    },
    {
      command: "reset-subtree",
      target: "pending",
      run: (graphPath) => resetSubtree(graphPath, { nodeId: "A", reason: "test reset" })
    },
    {
      command: "reset-reachable",
      target: "pending",
      run: (graphPath) => resetReachable(graphPath, { nodeId: "A", reason: "test reset" })
    },
    {
      command: "decompose",
      target: "pending",
      run: (graphPath) => decomposeNode(graphPath, {
        nodeId: "A",
        session: "owner",
        kind: "series",
        children: [{ id: "A1", title: "Child" }]
      }),
      rejects: /Cannot decompose node from status/
    }
  ];

  for (const item of leafCommandCases) {
    const allowedFrom = new Set(schedulerTransitionTable[item.command].allowedFrom);
    for (const status of knownTransitionStatuses) {
      for (const lease of [false, true]) {
        await t.test(`${item.command} from ${status} with ${lease ? "lease" : "no lease"}`, async () => {
          await withTempGraph(async (graphPath) => {
            await setNodeStatus(graphPath, "A", status, { lease });
            const shouldMutate = item.shouldMutate?.(status, lease) ?? allowedFrom.has(status);

            if (shouldMutate && (!item.requiresLease || lease)) {
              await item.run(graphPath);
              const graph = await readGraph(graphPath);
              assert.equal(graph.graph.nodes.A.status, item.target === "same" ? status : item.target);
              return;
            }

            await assert.rejects(
              item.run(graphPath),
              item.requiresLease && !lease ? /Cannot renew node without a lease/ : item.rejects
            );
          });
        });
      }
    }
  }
});

test("transition contract covers documented custom-status claim and reset behavior", async (t) => {
  const customStatus = "needs-specialist";

  await t.test("claim accepts a custom ready-compatible leaf status", async () => {
    await withTempGraph(async (graphPath) => {
      await setNodeStatus(graphPath, "A", customStatus);

      const result = await claimNode(graphPath, { session: "owner", nodeId: "A" });
      const graph = await readGraph(graphPath);

      assert.equal(result.nodeId, "A");
      assert.equal(graph.graph.nodes.A.status, "claimed");
      assert.ok(graph.graph.nodes.A.history.some((entry) => entry.event === "claimed" && entry.previousStatus === customStatus));
    });
  });

  for (const [command, run] of [
    ["reset", (graphPath) => resetNode(graphPath, { nodeId: "A", reason: "custom reset" })],
    ["reset-subtree", (graphPath) => resetSubtree(graphPath, { nodeId: "A", reason: "custom reset" })],
    ["reset-reachable", (graphPath) => resetReachable(graphPath, { nodeId: "A", reason: "custom reset" })]
  ]) {
    await t.test(`${command} resets a custom-status node`, async () => {
      await withTempGraph(async (graphPath) => {
        await setNodeStatus(graphPath, "A", customStatus, { lease: true });

        await run(graphPath);
        const graph = await readGraph(graphPath);

        assert.equal(graph.graph.nodes.A.status, "pending");
        assert.equal(graph.graph.nodes.A.lease, undefined);
        assert.ok(graph.graph.nodes.A.history.some((entry) => entry.event === "reset" && entry.previousStatus === customStatus));
      });
    });
  }
});

test("system transition commands cover every known status and lease condition", async (t) => {
  for (const status of knownTransitionStatuses) {
    for (const lease of [false, true]) {
      await t.test(`reconcile from ${status} with ${lease ? "lease" : "no lease"}`, async () => {
        await withTempGraph(async (graphPath) => {
          await setNodeStatus(graphPath, "B", "done");
          await setNodeStatus(graphPath, "C", "done");
          await setNodeStatus(graphPath, "P", status, { lease });
          const result = await reconcileGraphStatus(graphPath);
          const graph = await readGraph(graphPath);
          assert.equal(graph.graph.nodes.P.status, "done");
          assert.equal(result.changed.includes("P"), status !== "done");
        });
      });

      await t.test(`release-expired from ${status} with ${lease ? "expired lease" : "no lease"}`, async () => {
        await withTempGraph(async (graphPath) => {
          await setNodeStatus(graphPath, "A", status, {
            lease,
            expiresAt: "2026-05-27T00:00:00.000Z"
          });
          const result = await releaseExpiredLeases(graphPath, new Date("2026-05-27T00:00:01.000Z"));
          const graph = await readGraph(graphPath);
          const shouldRelease = lease && schedulerTransitionTable["release-expired"].allowedFrom.includes(status);
          assert.deepEqual(result.released, shouldRelease ? ["A"] : []);
          assert.equal(graph.graph.nodes.A.status, shouldRelease ? "pending" : status);
          assert.equal(Boolean(graph.graph.nodes.A.lease), lease && !shouldRelease);
        });
      });
    }
  }

  for (const status of schedulerTransitionTable["release-expired"].allowedFrom) {
    await t.test(`release-expired preserves active ${status} lease`, async () => {
      await withTempGraph(async (graphPath) => {
        await setNodeStatus(graphPath, "A", status, {
          lease: true,
          expiresAt: "2999-01-01T00:00:00.000Z"
        });
        const result = await releaseExpiredLeases(graphPath, new Date("2026-05-27T00:00:01.000Z"));
        const graph = await readGraph(graphPath);
        assert.deepEqual(result.released, []);
        assert.equal(graph.graph.nodes.A.status, status);
        assert.equal(graph.graph.nodes.A.lease.session, "owner");
      });
    });
  }
});

test("invalid transition failures keep stable operator-facing messages", async () => {
  await withTempGraph(async (graphPath) => {
    await assert.rejects(
      startNode(graphPath, { nodeId: "A" }),
      {
        message: "Cannot start node from status pending; expected one of claimed"
      }
    );
  });

  await withTempGraph(async (graphPath) => {
    await setNodeStatus(graphPath, "A", "claimed", { lease: false });
    await assert.rejects(
      renewNodeLease(graphPath, { nodeId: "A", session: "owner" }),
      {
        message: "Cannot renew node without a lease: A"
      }
    );
  });

  await withTempGraph(async (graphPath) => {
    await setNodeStatus(graphPath, "A", "claimed", { lease: true });
    await assert.rejects(
      completeNode(graphPath, { nodeId: "A" }),
      {
        message: "A session or runId is required to update a leased node"
      }
    );
  });

  await withTempGraph(async (graphPath) => {
    await setNodeStatus(graphPath, "A", "claimed", { lease: true });
    await assert.rejects(
      startNode(graphPath, { nodeId: "A", session: "intruder" }),
      {
        message: "Lease session mismatch for node; expected owner"
      }
    );
  });

  await withTempGraph(async (graphPath) => {
    await setNodeStatus(graphPath, "A", "done", { lease: false });
    await assert.rejects(
      claimNode(graphPath, { session: "owner", nodeId: "A" }),
      {
        message: `Node is not ready to claim: A in graph ${graphPath}`
      }
    );
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
    assert.ok(graph.graph.nodes.P.history.some((entry) => entry.event === "reset" && entry.resetScope === "subtree" && entry.reason === "rerun branch"));
    assert.ok(graph.graph.nodes.B.history.some((entry) => entry.event === "reset" && entry.resetScope === "subtree" && entry.rootId === "P"));
  });
});

test("completion requires output refs once sibling composition is isolated", async () => {
  await withTempGraph(async (graphPath) => {
    const graph = {
      graphVersion: 1,
      graph: {
        root: "ROOT",
        nodes: {
          ROOT: { title: "Root", kind: "series", status: "pending", children: ["A", "B"] },
          A: {
            title: "Isolated predecessor",
            kind: "task",
            status: "done",
            outputRef: { name: "refs/heads/spg/node/A/run-a" }
          },
          B: {
            title: "Shared-cwd successor",
            kind: "task",
            status: "claimed",
            lease: {
              session: "codex-B",
              runId: "run-b",
              claimedAt: "2026-05-27T00:00:00.000Z",
              expiresAt: "2099-01-01T00:00:00.000Z"
            }
          }
        }
      }
    };
    await writeFile(graphPath, `${JSON.stringify(graph, null, 2)}\n`, "utf8");

    await assert.rejects(
      completeNode(graphPath, { nodeId: "B", session: "codex-B", runId: "run-b" }),
      /Cannot complete isolated\/composed node without outputRef\.name: B/
    );

    const after = await readGraph(graphPath);
    assert.equal(after.graph.nodes.B.status, "claimed");
    assert.equal(after.graph.nodes.B.outputRef, undefined);
  });
});

test("resetting a child reopens unresolved blocked composition ancestors", async () => {
  await withTempGraph(async (graphPath) => {
    const graph = {
      graphVersion: 1,
      graph: {
        root: "ROOT",
        nodes: {
          ROOT: { title: "Root", kind: "series", status: "pending", children: ["BASELINE", "TAIL"] },
          BASELINE: {
            title: "Blocked baseline",
            kind: "series",
            status: "blocked",
            children: ["GUI01", "GUI04"],
            blockedAt: "2026-05-27T09:17:52.534Z",
            blockedReason: "series final child is done without outputRef: GUI04",
            question: "Resolve series integration for BASELINE.",
            report: "reports/BASELINE-integration.md",
            integrationRef: {
              name: "refs/heads/spg/node/GUI01/run-a",
              kind: "series",
              status: "pending",
              missingChildId: "GUI04"
            }
          },
          GUI01: {
            title: "Done isolated child",
            kind: "task",
            status: "done",
            outputRef: { name: "refs/heads/spg/node/GUI01/run-a" }
          },
          GUI04: { title: "Reset child", kind: "task", status: "pending" },
          TAIL: { title: "Tail", kind: "task", status: "pending" }
        }
      }
    };
    await writeFile(graphPath, `${JSON.stringify(graph, null, 2)}\n`, "utf8");

    assert.deepEqual(readyIds(await readGraph(graphPath)), []);
    const diagnostics = await diagnoseGraph(graphPath);
    assert.deepEqual(diagnostics.actions.filter((action) => /blocked\/review/.test(action)), [
      "Inspect or reset-subtree 1 blocked/review internal node(s)."
    ]);
    const blocked = diagnostics.blocked.find((node) => node.id === "BASELINE");
    assert.match(blocked.nextStep, /reset-subtree --node BASELINE/);
    assert.equal(blocked.remediation.commands.some((command) => command.command.includes(" answer ")), false);

    await resetReachable(graphPath, { nodeId: "GUI04", reason: "retry final child" });

    const after = await readGraph(graphPath);
    assert.equal(after.graph.nodes.BASELINE.status, "pending");
    assert.equal(after.graph.nodes.BASELINE.blockedReason, undefined);
    assert.equal(after.graph.nodes.BASELINE.question, undefined);
    assert.equal(after.graph.nodes.BASELINE.integrationRef, undefined);
    assert.deepEqual(readyIds(after), ["GUI04"]);
    assert.ok(after.graph.nodes.BASELINE.history.some((entry) => entry.event === "child-reset" && entry.previousStatus === "blocked" && entry.childId === "GUI04"));
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
    assert.ok(graph.graph.nodes.B.history.some((entry) => entry.event === "reset" && entry.resetScope === "reachable" && entry.reason === "rerun from branch B"));
    assert.ok(graph.graph.nodes.G.history.some((entry) => entry.event === "reset" && entry.resetScope === "reachable" && entry.rootId === "B"));
  });
});

test("reset-reachable follows execution order across nested parallel and series branches", async () => {
  const cases = [
    {
      nodeId: "L1",
      resetNodes: ["L1", "L2", "TAIL", "T1", "T2"],
      pending: ["L1", "L2", "TAIL", "T1", "T2"],
      stillDone: ["ROOT", "PREP", "FANOUT", "LEFT", "RIGHT", "R1", "RN", "RN1", "RN2"]
    },
    {
      nodeId: "RN",
      resetNodes: ["RN", "RN1", "RN2", "TAIL", "T1", "T2"],
      pending: ["RN", "RN1", "RN2", "TAIL", "T1", "T2"],
      stillDone: ["ROOT", "PREP", "FANOUT", "LEFT", "L1", "L2", "RIGHT", "R1"]
    }
  ];

  for (const { nodeId, resetNodes, pending, stillDone } of cases) {
    await withTempGraph(async (graphPath) => {
      const graph = {
        graphVersion: 1,
        title: "Nested Reset Reachability",
        graph: {
          root: "ROOT",
          nodes: {
            ROOT: { title: "Root", kind: "series", status: "done", children: ["PREP", "FANOUT", "TAIL"] },
            PREP: { title: "Prep", kind: "task", status: "done", report: "reports/PREP.md" },
            FANOUT: { title: "Fanout", kind: "parallel", status: "done", children: ["LEFT", "RIGHT"] },
            LEFT: { title: "Left", kind: "series", status: "done", children: ["L1", "L2"] },
            L1: { title: "L1", kind: "task", status: "done", report: "reports/L1.md" },
            L2: { title: "L2", kind: "task", status: "done", report: "reports/L2.md" },
            RIGHT: { title: "Right", kind: "parallel", status: "done", children: ["R1", "RN"] },
            R1: { title: "R1", kind: "task", status: "done", report: "reports/R1.md" },
            RN: { title: "Right nested", kind: "series", status: "done", children: ["RN1", "RN2"] },
            RN1: { title: "RN1", kind: "task", status: "done", report: "reports/RN1.md" },
            RN2: { title: "RN2", kind: "task", status: "done", report: "reports/RN2.md" },
            TAIL: { title: "Tail", kind: "series", status: "done", children: ["T1", "T2"] },
            T1: { title: "T1", kind: "task", status: "done", report: "reports/T1.md" },
            T2: { title: "T2", kind: "task", status: "done", report: "reports/T2.md" }
          }
        }
      };
      await writeFile(graphPath, `${JSON.stringify(graph, null, 2)}\n`, "utf8");

      const result = await resetReachable(graphPath, { nodeId, reason: `rerun from ${nodeId}` });
      assert.deepEqual(result.resetNodes, resetNodes);

      const updated = await readGraph(graphPath);
      for (const pendingNodeId of pending) {
        assert.equal(updated.graph.nodes[pendingNodeId].status, "pending", pendingNodeId);
        assert.equal(updated.graph.nodes[pendingNodeId].report, undefined, pendingNodeId);
      }
      for (const doneNodeId of stillDone) {
        assert.equal(updated.graph.nodes[doneNodeId].status, "done", doneNodeId);
      }
      assert.deepEqual(readyIds(updated), nodeId === "L1" ? ["L1"] : ["RN1"]);
    });
  }
});

test("reset-reachable examples cover nested leaves, internals, root, and unreachable nodes", async () => {
  const rootReachableNodes = [
    "ROOT",
    "PREP",
    "P1",
    "P2",
    "FANOUT",
    "LEFT",
    "L1",
    "L2",
    "RIGHT",
    "R1",
    "RN",
    "RN1",
    "RN2",
    "TAIL",
    "T1",
    "T2",
    "CLEANUP"
  ];
  const unreachableNodes = ["ORPHAN", "O1", "O2"];
  const cases = [
    {
      nodeId: "L1",
      resetNodes: ["L1", "L2", "TAIL", "T1", "T2", "CLEANUP"],
      stillDone: ["ROOT", "PREP", "P1", "P2", "FANOUT", "LEFT", "RIGHT", "R1", "RN", "RN1", "RN2"]
    },
    {
      nodeId: "LEFT",
      resetNodes: ["LEFT", "L1", "L2", "TAIL", "T1", "T2", "CLEANUP"],
      stillDone: ["ROOT", "PREP", "P1", "P2", "FANOUT", "RIGHT", "R1", "RN", "RN1", "RN2"]
    },
    {
      nodeId: "RIGHT",
      resetNodes: ["RIGHT", "R1", "RN", "RN1", "RN2", "TAIL", "T1", "T2", "CLEANUP"],
      stillDone: ["ROOT", "PREP", "P1", "P2", "FANOUT", "LEFT", "L1", "L2"]
    },
    {
      nodeId: "FANOUT",
      resetNodes: ["FANOUT", "LEFT", "L1", "L2", "RIGHT", "R1", "RN", "RN1", "RN2", "TAIL", "T1", "T2", "CLEANUP"],
      stillDone: ["ROOT", "PREP", "P1", "P2"]
    },
    {
      nodeId: "ROOT",
      resetNodes: rootReachableNodes,
      stillDone: unreachableNodes
    },
    {
      nodeId: "ORPHAN",
      resetNodes: ["ORPHAN", "O1", "O2"],
      stillDone: rootReachableNodes
    }
  ];

  for (const { nodeId, resetNodes, stillDone } of cases) {
    await withTempGraph(async (graphPath) => {
      await writeFile(graphPath, `${JSON.stringify(nestedResetReachabilityGraph(), null, 2)}\n`, "utf8");

      const result = await resetReachable(graphPath, { nodeId, reason: `audit ${nodeId}` });
      assert.deepEqual(result.resetNodes, resetNodes, nodeId);

      const graph = await readGraph(graphPath);
      for (const resetNodeId of resetNodes) {
        assert.equal(graph.graph.nodes[resetNodeId].status, "pending", resetNodeId);
        assert.equal(graph.graph.nodes[resetNodeId].report, undefined, resetNodeId);
      }
      for (const doneNodeId of stillDone) {
        assert.equal(graph.graph.nodes[doneNodeId].status, "done", doneNodeId);
      }
      assert.ok(graph.graph.nodes[nodeId].history.some((entry) => entry.event === "reset" && entry.resetScope === "reachable" && entry.reason === `audit ${nodeId}`));
    });
  }
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
    assert.ok(reconciled.graph.nodes.P.history.some((entry) => entry.event === "subtree-done"));

    const cli = await execFileAsync(process.execPath, [schedulerScriptPath, "reconcile", "--graph", graphPath]);
    assert.deepEqual(JSON.parse(cli.stdout).changed, []);
  });
});
