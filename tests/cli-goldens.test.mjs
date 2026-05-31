import test from "node:test";
import { answerNode, assert, assertCliFails, assertCliGolden, assertReadableGraphValidationOutput, blockNode, buildGoalGraph, buildVisualizerPayload, buildWorkerPrompt, captureSchedulerCli, claimNode, completeNode, copyGraphFixtureToTemp, createServer, createVisualizerServer, depthPriorityGraph, diagnoseGraph, dirname, execFileAsync, existsSync, fixtureGraph, graphValidationCases, join, listReadyLeafNodes, mkdir, mkdtemp, parseArgs, parseChildrenArgs, readGraph, renderCliHelp, renderVisualizerHtml, rendererDocumentFixture, rendererScriptPath, resolveWorkerIsolation, rm, schedulerScriptPath, symlink, tmpdir, utimes, validatePlanGraphFileResult, withTempGraph, writeFile } from "./helpers/plan-scheduler-harness.mjs";

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

test("diagnostics include structured remediation commands for actionable categories", async () => {
  await withTempGraph(async (graphPath) => {
    const graph = fixtureGraph();
    graph.graph.nodes.A.status = "running";
    graph.graph.nodes.A.lease = {
      session: "expired-worker",
      runId: "run_20260527_000000000_A_00000000",
      claimedAt: "2026-05-27T00:00:00.000Z",
      expiresAt: "2026-05-27T00:00:01.000Z"
    };
    graph.graph.nodes.B.status = "blocked";
    graph.graph.nodes.B.question = "Use cached output?";
    graph.graph.nodes.C.status = "failed";
    graph.graph.nodes.C.failureReason = "Tests failed";
    graph.graph.nodes.C.report = "reports/C.md";
    await writeFile(graphPath, `${JSON.stringify(graph, null, 2)}\n`, "utf8");

    const diagnostics = await diagnoseGraph(graphPath);
    const remediationByCategory = new Map(diagnostics.remediation.map((entry) => [entry.category, entry]));

    assert.match(remediationByCategory.get("expired-lease").commands[0].command, /release-expired --graph /);
    assert.equal(remediationByCategory.get("expired-lease").commands[0].safeToRun, true);
    assert.match(remediationByCategory.get("blocked-work").commands[0].command, /events --graph .* --event blocked/);
    assert.match(remediationByCategory.get("failed-node").commands[0].command, /events --graph .* --event failed/);
    assert.match(remediationByCategory.get("failed-node").prerequisites[0], /Inspect each failed node report/);
    assert.match(remediationByCategory.get("no-ready").commands[0].command, /diagnostics --graph /);

    const blockedNode = diagnostics.blocked.find((node) => node.id === "B");
    assert.match(blockedNode.remediation.commands[0].command, /answer --graph .* --node B --answer '<answer>'/);
    const failedNode = diagnostics.failed.find((node) => node.id === "C");
    assert.match(failedNode.remediation.commands[1].command, /reset --graph .* --node C --reason '<verified retry reason>'/);
    assert.match(failedNode.remediation.commands[1].prerequisites[0], /reports\/C\.md/);
  });
});

test("diagnostics stale-lock remediation requires verification and avoids destructive cleanup", async () => {
  await withTempGraph(async (graphPath) => {
    const lockPath = `${graphPath}.lock`;
    await mkdir(lockPath);
    await writeFile(
      join(lockPath, "metadata.json"),
      `${JSON.stringify({
        pid: 24680,
        createdAt: "2026-05-27T02:00:00.000Z",
        graphPath,
        host: "cli-test-host"
      })}\n`,
      "utf8"
    );
    const oldTime = new Date("2000-01-01T00:00:00.000Z");
    await utimes(lockPath, oldTime, oldTime);

    const diagnostics = await diagnoseGraph(graphPath);
    const staleLock = diagnostics.remediation.find((entry) => entry.category === "stale-lock");
    const suggestedCommands = staleLock.commands.map((entry) => entry.command).join("\n");

    assert.equal(diagnostics.lock.stale, true);
    assert.match(staleLock.commands[0].command, /^ps -p 24680$/);
    assert.match(staleLock.prerequisites[0], /Confirm the recorded owner process is gone/);
    assert.doesNotMatch(suggestedCommands, /\brm\b|remove|delete|cleanup/i);
  });
});

test("CLI golden outputs cover public command shapes", async () => {
  const actual = {};

  async function captureWithFreshGraph(name, run) {
    await withTempGraph(async (graphPath, dir) => {
      const replacements = { [graphPath]: "<graphPath>", [dir]: "<graphDir>" };
      actual[name] = await run(graphPath, replacements);
    });
  }

  actual.help = await captureSchedulerCli(["help"]);

  await captureWithFreshGraph("planDryRun", (graphPath, replacements) =>
    captureSchedulerCli(["plan", "--goal", "Ship a searchable audit log", "--graph", join(dirname(graphPath), "planned.graph.json"), "--title", "Audit Log Plan", "--dry-run"], {
      replacements: {
        ...replacements,
        [join(dirname(graphPath), "planned.graph.json")]: "<plannedGraphPath>"
      }
    })
  );
  await captureWithFreshGraph("planWrite", (graphPath, replacements) =>
    captureSchedulerCli(["plan", "--goal", "Create a release checklist", "--graph", join(dirname(graphPath), "release-plan.graph.json")], {
      replacements: {
        ...replacements,
        [join(dirname(graphPath), "release-plan.graph.json")]: "<plannedGraphPath>"
      }
    })
  );

  await captureWithFreshGraph("ready", (graphPath, replacements) =>
    captureSchedulerCli(["ready", "--graph", graphPath], { replacements })
  );
  await captureWithFreshGraph("readyPriorityMetadata", async (graphPath, replacements) => {
    await writeFile(graphPath, `${JSON.stringify(depthPriorityGraph(), null, 2)}\n`, "utf8");
    return captureSchedulerCli(["ready", "--graph", graphPath], { replacements });
  });
  await captureWithFreshGraph("summary", (graphPath, replacements) =>
    captureSchedulerCli(["summary", "--graph", graphPath], { replacements })
  );
  await captureWithFreshGraph("diagnostics", (graphPath, replacements) =>
    captureSchedulerCli(["diagnostics", "--graph", graphPath], { replacements })
  );
  await captureWithFreshGraph("diagnosticsPriorityMetadata", async (graphPath, replacements) => {
    await writeFile(graphPath, `${JSON.stringify(depthPriorityGraph(), null, 2)}\n`, "utf8");
    return captureSchedulerCli(["diagnostics", "--graph", graphPath], { replacements });
  });
  await captureWithFreshGraph("events", async (graphPath, replacements) => {
    await claimNode(graphPath, { nodeId: "A", session: "golden-events" });
    return captureSchedulerCli(["events", "--graph", graphPath, "--limit", "5"], { replacements });
  });
  await captureWithFreshGraph("claim", (graphPath, replacements) =>
    captureSchedulerCli(["claim", "--graph", graphPath, "--node", "A", "--session", "golden-claim", "--lease", "60"], { replacements })
  );
  await captureWithFreshGraph("claimPriority", async (graphPath, replacements) => {
    await writeFile(graphPath, `${JSON.stringify(depthPriorityGraph(), null, 2)}\n`, "utf8");
    return captureSchedulerCli(["claim", "--graph", graphPath, "--session", "golden-claim-priority", "--lease", "60"], { replacements });
  });
  await captureWithFreshGraph("start", async (graphPath, replacements) => {
    const claim = await claimNode(graphPath, { nodeId: "A", session: "golden-start" });
    return captureSchedulerCli(["start", "--graph", graphPath, "--node", "A", "--session", "golden-start", "--run", claim.runId], { replacements });
  });
  await captureWithFreshGraph("renew", async (graphPath, replacements) => {
    const claim = await claimNode(graphPath, { nodeId: "A", session: "golden-renew" });
    return captureSchedulerCli(["renew", "--graph", graphPath, "--node", "A", "--session", "golden-renew", "--run", claim.runId, "--lease", "120"], { replacements });
  });
  await captureWithFreshGraph("reset", async (graphPath, replacements) => {
    await claimNode(graphPath, { nodeId: "A", session: "golden-reset" });
    return captureSchedulerCli(["reset", "--graph", graphPath, "--node", "A", "--reason", "retry leaf"], { replacements });
  });
  await captureWithFreshGraph("resetSubtree", async (graphPath, replacements) => {
    const graph = fixtureGraph();
    graph.graph.nodes.A.status = "done";
    graph.graph.nodes.P.status = "done";
    graph.graph.nodes.B.status = "done";
    graph.graph.nodes.C.status = "done";
    await writeFile(graphPath, `${JSON.stringify(graph, null, 2)}\n`, "utf8");
    return captureSchedulerCli(["reset-subtree", "--graph", graphPath, "--node", "P", "--reason", "retry branch"], { replacements });
  });
  await captureWithFreshGraph("resetReachable", async (graphPath, replacements) => {
    const graph = fixtureGraph();
    graph.graph.nodes.A.status = "done";
    graph.graph.nodes.P.status = "done";
    graph.graph.nodes.B.status = "done";
    graph.graph.nodes.C.status = "done";
    graph.graph.nodes.G.status = "done";
    graph.graph.nodes.ROOT.status = "done";
    await writeFile(graphPath, `${JSON.stringify(graph, null, 2)}\n`, "utf8");
    return captureSchedulerCli(["reset-reachable", "--graph", graphPath, "--node", "A", "--reason", "retry downstream"], { replacements });
  });
  await captureWithFreshGraph("done", async (graphPath, replacements) => {
    await claimNode(graphPath, { nodeId: "A", session: "golden-done" });
    return captureSchedulerCli(["done", "--graph", graphPath, "--node", "A", "--session", "golden-done", "--report", "reports/A.md"], { replacements });
  });
  await captureWithFreshGraph("block", async (graphPath, replacements) => {
    await claimNode(graphPath, { nodeId: "A", session: "golden-block" });
    return captureSchedulerCli(["block", "--graph", graphPath, "--node", "A", "--session", "golden-block", "--question", "Need operator decision"], { replacements });
  });
  await captureWithFreshGraph("answer", async (graphPath, replacements) => {
    await claimNode(graphPath, { nodeId: "A", session: "golden-answer" });
    await blockNode(graphPath, { nodeId: "A", session: "golden-answer", question: "Proceed?" });
    return captureSchedulerCli(["answer", "--graph", graphPath, "--node", "A", "--answer", "Continue.", "--responder", "tester"], { replacements });
  });
  await captureWithFreshGraph("fail", async (graphPath, replacements) => {
    await claimNode(graphPath, { nodeId: "A", session: "golden-fail" });
    return captureSchedulerCli(["fail", "--graph", graphPath, "--node", "A", "--session", "golden-fail", "--reason", "failed check", "--report", "reports/A.md"], { replacements });
  });
  await captureWithFreshGraph("decompose", async (graphPath, replacements) => {
    await claimNode(graphPath, { nodeId: "A", session: "golden-decompose" });
    return captureSchedulerCli([
      "decompose",
      "--graph",
      graphPath,
      "--node",
      "A",
      "--session",
      "golden-decompose",
      "--kind",
      "series",
      "--child",
      "A1=First child",
      "--child",
      "A2=Second child"
    ], { replacements });
  });
  await captureWithFreshGraph("applyPreview", async (graphPath, replacements) => {
    const claim = await claimNode(graphPath, { nodeId: "A", session: "golden-apply-preview" });
    await blockNode(graphPath, {
      nodeId: "A",
      session: "golden-apply-preview",
      runId: claim.runId,
      question: "Approve planner preview?",
      reason: "planner proposed series decomposition",
      plannerPreview: {
        requestId: "golden-preview-apply",
        proposedKind: "series",
        childIds: ["A_PREVIEW"],
        response: { kind: "series", title: "Apply preview", children: [{ id: "A_PREVIEW", title: "Preview child" }] },
        decompose: { kind: "series", children: [{ id: "A_PREVIEW", title: "Preview child" }] },
        createdAt: "2026-05-31T00:00:00.000Z"
      }
    });
    return captureSchedulerCli([
      "apply-preview",
      "--graph",
      graphPath,
      "--node",
      "A",
      "--session",
      "golden-apply-preview",
      "--run",
      claim.runId
    ], { replacements });
  });
  await captureWithFreshGraph("rejectPreview", async (graphPath, replacements) => {
    const claim = await claimNode(graphPath, { nodeId: "A", session: "golden-reject-preview" });
    await blockNode(graphPath, {
      nodeId: "A",
      session: "golden-reject-preview",
      runId: claim.runId,
      question: "Approve planner preview?",
      reason: "planner proposed parallel decomposition",
      plannerPreview: {
        requestId: "golden-preview-reject",
        proposedKind: "parallel",
        childIds: ["A_REJECTED"],
        response: { kind: "parallel", title: "Reject preview", children: [{ id: "A_REJECTED", title: "Rejected child" }] },
        decompose: { kind: "parallel", children: [{ id: "A_REJECTED", title: "Rejected child" }] },
        createdAt: "2026-05-31T00:00:00.000Z"
      }
    });
    return captureSchedulerCli([
      "reject-preview",
      "--graph",
      graphPath,
      "--node",
      "A",
      "--reason",
      "too broad",
      "--responder",
      "tester"
    ], { replacements });
  });
  await captureWithFreshGraph("reconcile", async (graphPath, replacements) => {
    const graph = fixtureGraph();
    graph.graph.nodes.A.status = "done";
    graph.graph.nodes.B.status = "done";
    graph.graph.nodes.C.status = "done";
    graph.graph.nodes.G.status = "done";
    await writeFile(graphPath, `${JSON.stringify(graph, null, 2)}\n`, "utf8");
    return captureSchedulerCli(["reconcile", "--graph", graphPath], { replacements });
  });
  await captureWithFreshGraph("releaseExpired", async (graphPath, replacements) => {
    const graph = fixtureGraph();
    graph.graph.nodes.A.status = "running";
    graph.graph.nodes.A.startedAt = "2026-05-27T00:00:00.000Z";
    graph.graph.nodes.A.lease = {
      session: "golden-expired",
      runId: "run_20260527_000000000_A_00000000",
      claimedAt: "2026-05-27T00:00:00.000Z",
      expiresAt: "2026-05-27T00:00:01.000Z"
    };
    await writeFile(graphPath, `${JSON.stringify(graph, null, 2)}\n`, "utf8");
    return captureSchedulerCli(["release-expired", "--graph", graphPath], { replacements });
  });
  await captureWithFreshGraph("workerIdle", async (graphPath, replacements) => {
    const graph = fixtureGraph();
    for (const node of Object.values(graph.graph.nodes)) {
      node.status = "done";
    }
    await writeFile(graphPath, `${JSON.stringify(graph, null, 2)}\n`, "utf8");
    return captureSchedulerCli(["worker", "--graph", graphPath, "--session", "golden-idle", "--once", "--quiet"], { replacements });
  });
  await captureWithFreshGraph("workerDone", async (graphPath, replacements) => {
    const runnerPath = join(dirname(graphPath), "golden-worker-done.mjs");
    await writeFile(runnerPath, "console.log('golden worker completed');\n", "utf8");
    return captureSchedulerCli([
      "worker",
      "--graph",
      graphPath,
      "--session",
      "golden-worker-done",
      "--once",
      "--quiet",
      "--cwd",
      dirname(graphPath),
      "--codex-command",
      process.execPath,
      "--codex-arg",
      runnerPath
    ], { replacements: { ...replacements, [runnerPath]: "<runnerPath>" } });
  });
  await captureWithFreshGraph("workerFailed", async (graphPath, replacements) => {
    const runnerPath = join(dirname(graphPath), "golden-worker-failed.mjs");
    await writeFile(runnerPath, "console.error('golden worker failed'); process.exit(7);\n", "utf8");
    return captureSchedulerCli([
      "worker",
      "--graph",
      graphPath,
      "--session",
      "golden-worker-failed",
      "--once",
      "--quiet",
      "--cwd",
      dirname(graphPath),
      "--codex-command",
      process.execPath,
      "--codex-arg",
      runnerPath
    ], { replacements: { ...replacements, [runnerPath]: "<runnerPath>" } });
  });
  await captureWithFreshGraph("malformedFlags", async (graphPath, replacements) => ({
    booleanValue: await captureSchedulerCli(["worker", "--graph", graphPath, "--once", "false"], { replacements }),
    repeatedScalar: await captureSchedulerCli(["prompt", "--graph", graphPath, "--node", "A", "--node", "B"], { replacements }),
    missingRequired: await captureSchedulerCli(["answer", "--graph", graphPath, "--node", "A"], { replacements }),
    invalidNumber: await captureSchedulerCli(["claim", "--graph", graphPath, "--lease", "nope"], { replacements }),
    missingFlagValue: await captureSchedulerCli(["renew", "--graph", graphPath, "--node", "A", "--lease"], { replacements })
  }));
  await captureWithFreshGraph("commandFailures", async (graphPath, replacements) => ({
    invalidTransition: await captureSchedulerCli(["done", "--graph", graphPath, "--node", "A"], { replacements }),
    invalidChildJson: await captureSchedulerCli(["decompose", "--graph", graphPath, "--node", "A", "--child-json", "{}"], { replacements }),
    priorityEligibility: await (async () => {
      await writeFile(graphPath, `${JSON.stringify(depthPriorityGraph(), null, 2)}\n`, "utf8");
      return captureSchedulerCli(["claim", "--graph", graphPath, "--node", "DEEP_WRAP", "--session", "golden-priority-failure"], { replacements });
    })()
  }));
  await captureWithFreshGraph("invalidGraph", async (graphPath, replacements) => {
    const graph = fixtureGraph();
    delete graph.graph.root;
    await writeFile(graphPath, `${JSON.stringify(graph, null, 2)}\n`, "utf8");
    return captureSchedulerCli(["ready", "--graph", graphPath], { replacements });
  });

  await assertCliGolden(actual);
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
    await assertCliFails(
      ["serve", "--graph", graphPath, "--host", "0.0.0.0", "--port", "0"],
      /Refusing to bind visualizer write endpoints to 0\.0\.0\.0 without protection/
    );
  });
});

test("goal graph factory creates a deterministic valid root graph", () => {
  const graph = buildGoalGraph("Ship a searchable audit log", {
    title: "Audit Log Plan",
    createdAt: "2026-05-31T00:00:00.000Z"
  });
  const validation = validatePlanGraphFileResult(graph);

  assert.deepEqual(validation.errors, []);
  assert.equal(graph.graphVersion, 1);
  assert.equal(graph.title, "Audit Log Plan");
  assert.deepEqual(graph.statusModel, ["pending", "claimed", "running", "blocked", "review", "failed", "done"]);
  assert.deepEqual(graph.scheduler, {
    stateFile: "plan.graph.json",
    htmlView: "plan.html",
    reportsDir: "reports",
    leaseSeconds: 1800
  });
  assert.equal(graph.graph.root, "ROOT");
  assert.deepEqual(graph.graph.nodes.ROOT.children, ["PLAN"]);
  assert.equal(graph.graph.nodes.ROOT.goal.text, "Ship a searchable audit log");
  assert.equal(graph.graph.nodes.PLAN.goal.text, "Ship a searchable audit log");
  assert.equal(graph.document.pageTitle, "Audit Log Plan");
});

test("goal graph factory materializes validated planner output as native graph nodes", () => {
  const graph = buildGoalGraph("Ship a searchable audit log", {
    title: "Audit Log Plan",
    createdAt: "2026-05-31T00:00:00.000Z",
    plannerResponse: {
      requestId: "goal-plan-ROOT-1",
      kind: "parallel",
      title: "Audit log delivery fanout",
      children: [
        { id: "AUDIT_BACKEND", title: "Implement audit backend" },
        { idHint: "AUDIT_UI", title: "Implement audit UI" }
      ]
    }
  });
  const validation = validatePlanGraphFileResult(graph);

  assert.deepEqual(validation.errors, []);
  assert.equal(graph.graph.nodes.ROOT.kind, "parallel");
  assert.deepEqual(graph.graph.nodes.ROOT.children, ["AUDIT_BACKEND", "ROOT_AUDIT_UI"]);
  assert.equal(graph.graph.nodes.AUDIT_BACKEND.kind, "task");
  assert.equal(graph.graph.nodes.AUDIT_BACKEND.goal.source, "planner");
  assert.equal(graph.graph.nodes.ROOT.planner.requestId, "goal-plan-ROOT-1");
  assert.deepEqual(listReadyLeafNodes(graph).map((node) => node.id), ["AUDIT_BACKEND", "ROOT_AUDIT_UI"]);
});

test("goal graph factory recursively materializes nested planner output with stable generated id collisions", () => {
  const graph = buildGoalGraph("Ship nested planner work", {
    title: "Nested Planner Plan",
    createdAt: "2026-05-31T00:00:00.000Z",
    plannerResponse: {
      requestId: "goal-plan-ROOT-nested",
      kind: "series",
      title: "Nested delivery sequence",
      children: [
        {
          title: "Build API",
          kind: "parallel",
          children: [
            { title: "Contract" },
            { id: "ROOT_BUILD_API_CONTRACT", title: "Pinned contract id" }
          ]
        },
        {
          idHint: "verify",
          title: "Verify graph"
        }
      ]
    }
  });
  const validation = validatePlanGraphFileResult(graph);

  assert.deepEqual(validation.errors, []);
  assert.deepEqual(graph.graph.nodes.ROOT.children, ["ROOT_BUILD_API", "ROOT_VERIFY"]);
  assert.equal(graph.graph.nodes.ROOT_BUILD_API.kind, "parallel");
  assert.deepEqual(graph.graph.nodes.ROOT_BUILD_API.children, ["ROOT_BUILD_API_CONTRACT_2", "ROOT_BUILD_API_CONTRACT"]);
  assert.equal(graph.graph.nodes.ROOT_BUILD_API_CONTRACT_2.title, "Contract");
  assert.equal(graph.graph.nodes.ROOT_BUILD_API_CONTRACT.title, "Pinned contract id");
  assert.deepEqual(
    listReadyLeafNodes(graph).map((node) => node.id),
    ["ROOT_BUILD_API_CONTRACT", "ROOT_BUILD_API_CONTRACT_2"]
  );
});

test("goal graph factory rejects invalid nested planner child shapes before graph write", () => {
  const cases = [
    {
      name: "empty nested composite",
      response: {
        kind: "series",
        title: "Empty nested",
        children: [{ kind: "parallel", title: "Empty fanout", children: [] }]
      },
      code: "missing-children",
      path: "$.children[0].children"
    },
    {
      name: "duplicate nested id",
      response: {
        kind: "parallel",
        title: "Duplicate nested",
        children: [
          { id: "DUPLICATE", title: "First" },
          { kind: "series", title: "Second branch", children: [{ id: "DUPLICATE", title: "Second" }] }
        ]
      },
      code: "duplicate-child-id",
      path: "$.children[1].children[0].id"
    },
    {
      name: "task with nested children",
      response: {
        kind: "series",
        title: "Unsupported nested",
        children: [{ kind: "task", title: "Task parent", children: [{ title: "Nested" }] }]
      },
      code: "unsupported-nested-children",
      path: "$.children[0].children"
    },
    {
      name: "root id collision",
      response: {
        kind: "series",
        title: "Root collision",
        children: [{ id: "ROOT", title: "Would collide with root" }]
      },
      code: "duplicate-child-id",
      path: "$.children[0].id"
    }
  ];

  for (const testCase of cases) {
    assert.throws(
      () => buildGoalGraph("Reject invalid nested planner output", {
        createdAt: "2026-05-31T00:00:00.000Z",
        plannerResponse: testCase.response
      }),
      (error) => {
        assert.equal(error.name, "PlannerResponseValidationError", testCase.name);
        assert.ok(
          error.validation.errors.some((issue) => issue.code === testCase.code && issue.path === testCase.path),
          testCase.name
        );
        return true;
      }
    );
  }
});

test("CLI plan creates a valid graph and rejects unsafe inputs", async () => {
  const dir = await mkdtemp(join(tmpdir(), "plan-cli-"));
  let outsideDir;
  let visualizer;
  try {
    const graphPath = join(dir, "nested", "plan.graph.json");
    const cli = await execFileAsync(process.execPath, [
      schedulerScriptPath,
      "plan",
      "--goal",
      "Ship a searchable audit log",
      "--title",
      "Audit Log Plan",
      "--graph",
      graphPath
    ]);
    const result = JSON.parse(cli.stdout);
    assert.equal(result.graphPath, graphPath);
    assert.equal(result.mode, "plan-only");
    assert.equal(result.written, true);
    assert.equal(result.dryRun, false);
    assert.equal(result.rootId, "ROOT");
    assert.equal(result.nodeCount, 2);
    assert.match(result.nextCommands.summary, /summary --graph /);
    assert.match(result.nextCommands.run, /worker --graph /);
    assert.equal(result.summary.totalNodes, 2);
    assert.equal(result.summary.root, "ROOT");
    assert.deepEqual(result.summary.counts, { pending: 2 });
    assert.equal(result.graph.graph.nodes.ROOT.goal.text, "Ship a searchable audit log");
    assert.equal(result.graph.graph.nodes.PLAN.goal.text, "Ship a searchable audit log");

    const graph = await readGraph(graphPath);
    assert.equal(graph.title, "Audit Log Plan");
    assert.equal(graph.graph.root, "ROOT");
    assert.deepEqual(listReadyLeafNodes(graph).map((node) => node.id), ["PLAN"]);
    assert.equal(graph.scheduler.htmlView, "plan.html");
    assert.equal(graph.scheduler.reportsDir, "reports");
    assert.equal(graph.scheduler.htmlView.includes(".."), false);
    assert.equal(graph.scheduler.reportsDir.includes(".."), false);

    const payload = await buildVisualizerPayload(graphPath);
    assert.equal(payload.nodes.find((node) => node.id === "ROOT").goal.text, "Ship a searchable audit log");
    assert.equal(payload.nodes.find((node) => node.id === "PLAN").goal.text, "Ship a searchable audit log");

    const summaryCli = await execFileAsync(process.execPath, [schedulerScriptPath, "summary", "--graph", graphPath]);
    assert.equal(JSON.parse(summaryCli.stdout).totalNodes, 2);
    const readyCli = await execFileAsync(process.execPath, [schedulerScriptPath, "ready", "--graph", graphPath]);
    assert.deepEqual(JSON.parse(readyCli.stdout).map((node) => node.id), ["PLAN"]);
    await execFileAsync(process.execPath, [rendererScriptPath, "--graph", graphPath]);
    assert.equal(existsSync(join(dirname(graphPath), "plan.html")), true);
    visualizer = await createVisualizerServer({ graphPath, port: 0 });
    assert.equal((await (await fetch(`${visualizer.url}/api/summary`)).json()).totalNodes, 2);

    const dryRunDir = join(dir, "dry-run");
    const dryRunPath = join(dryRunDir, "plan.graph.json");
    const dryRun = await execFileAsync(process.execPath, [
      schedulerScriptPath,
      "plan",
      "--goal",
      "Preview only",
      "--graph",
      dryRunPath,
      "--dry-run"
    ]);
    const dryRunResult = JSON.parse(dryRun.stdout);
    assert.equal(dryRunResult.written, false);
    assert.equal(dryRunResult.dryRun, true);
    assert.equal(existsSync(dryRunPath), false);
    assert.equal(existsSync(dryRunDir), false);

    await assertCliFails(
      ["plan", "--goal", "   ", "--graph", join(dir, "empty-goal.graph.json")],
      /plan requires --goal/
    );

    await assertCliFails(
      ["plan", "--goal", "Overwrite existing", "--graph", graphPath],
      /Refusing to overwrite existing graph file:/
    );

    await assertCliFails(
      ["plan", "--goal", "Preview existing", "--graph", graphPath, "--dry-run"],
      /Refusing to overwrite existing graph file:/
    );

    const containedRealDir = join(dir, "contained-real");
    const containedLinkDir = join(dir, "contained-link");
    await mkdir(containedRealDir);
    await symlink(containedRealDir, containedLinkDir);
    const containedGraphPath = join(containedLinkDir, "plan.graph.json");
    const containedCli = await execFileAsync(process.execPath, [
      schedulerScriptPath,
      "plan",
      "--goal",
      "Write through contained link",
      "--graph",
      containedGraphPath
    ]);
    assert.equal(JSON.parse(containedCli.stdout).graphPath, containedGraphPath);
    assert.equal(existsSync(join(containedRealDir, "plan.graph.json")), true);

    const nonDirectoryParent = join(dir, "not-a-directory");
    await writeFile(nonDirectoryParent, "not a directory", "utf8");
    await assertCliFails(
      ["plan", "--goal", "Parent is a file", "--graph", join(nonDirectoryParent, "plan.graph.json")],
      /Unsafe graph output path: parent is not a directory:/
    );

    const symlinkTargetPath = join(dir, "symlink-target.graph.json");
    const symlinkGraphPath = join(dir, "symlink.graph.json");
    await symlink(symlinkTargetPath, symlinkGraphPath);
    await assertCliFails(
      ["plan", "--goal", "Target is a link", "--graph", symlinkGraphPath],
      /Unsafe graph output path: target is a symbolic link:/
    );

    outsideDir = await mkdtemp(join(tmpdir(), "plan-cli-outside-"));
    const linkedDir = join(dir, "linked-output");
    await symlink(outsideDir, linkedDir);
    await assertCliFails(
      ["plan", "--goal", "Write through link", "--graph", join(linkedDir, "plan.graph.json")],
      /Unsafe graph output path: parent escapes containing directory:/
    );
    await assertCliFails(
      ["plan", "--goal", "Preview through link", "--graph", join(linkedDir, "dry-run.graph.json"), "--dry-run"],
      /Unsafe graph output path: parent escapes containing directory:/
    );
  } finally {
    await visualizer?.close();
    await rm(dir, { recursive: true, force: true });
    if (outsideDir) {
      await rm(outsideDir, { recursive: true, force: true });
    }
  }
});

test("CLI plan with fixture planner writes composite goal graphs", async () => {
  const dir = await mkdtemp(join(tmpdir(), "plan-fixture-cli-"));
  let visualizer;
  try {
    const graphPath = join(dir, "planner", "plan.graph.json");
    const fixturePath = join(dir, "planner-fixture.json");
    await writeFile(fixturePath, JSON.stringify({
      kind: "series",
      title: "Fixture-generated implementation plan",
      rationale: "The contract should be settled before implementation.",
      children: [
        { id: "GOAL_CONTRACT", title: "Define fixture contract" },
        { id: "GOAL_IMPLEMENT", title: "Implement fixture behavior" },
        { id: "GOAL_VERIFY", title: "Verify fixture behavior" }
      ]
    }, null, 2), "utf8");

    const cli = await execFileAsync(process.execPath, [
      schedulerScriptPath,
      "plan",
      "--goal",
      "Build fixture planner graph",
      "--graph",
      graphPath,
      "--planner-mode",
      "auto-decompose",
      "--planner-adapter",
      "fixture",
      "--planner-fixture",
      fixturePath
    ]);
    const result = JSON.parse(cli.stdout);

    assert.equal(result.written, true);
    assert.equal(result.nodeCount, 4);
    assert.equal(result.summary.totalNodes, 4);
    assert.deepEqual(result.summary.counts, { pending: 4 });
    assert.equal(result.graph.graph.nodes.ROOT.kind, "series");
    assert.deepEqual(result.graph.graph.nodes.ROOT.children, ["GOAL_CONTRACT", "GOAL_IMPLEMENT", "GOAL_VERIFY"]);
    assert.equal(result.graph.graph.nodes.ROOT.planner.requestId, "goal-plan-ROOT-1");
    assert.notDeepEqual(result.graph.graph.nodes.ROOT.children, ["PLAN"]);

    const graph = await readGraph(graphPath);
    assert.deepEqual(listReadyLeafNodes(graph).map((node) => node.id), ["GOAL_CONTRACT"]);

    const summaryCli = await execFileAsync(process.execPath, [schedulerScriptPath, "summary", "--graph", graphPath]);
    assert.equal(JSON.parse(summaryCli.stdout).totalNodes, 4);
    const readyCli = await execFileAsync(process.execPath, [schedulerScriptPath, "ready", "--graph", graphPath]);
    assert.deepEqual(JSON.parse(readyCli.stdout).map((node) => node.id), ["GOAL_CONTRACT"]);
    const diagnosticsCli = await execFileAsync(process.execPath, [schedulerScriptPath, "diagnostics", "--graph", graphPath]);
    assert.equal(JSON.parse(diagnosticsCli.stdout).summary.totalNodes, 4);
    await execFileAsync(process.execPath, [rendererScriptPath, "--graph", graphPath]);
    assert.equal(existsSync(join(dirname(graphPath), "plan.html")), true);
    visualizer = await createVisualizerServer({ graphPath, port: 0 });
    assert.equal((await (await fetch(`${visualizer.url}/api/summary`)).json()).totalNodes, 4);
  } finally {
    await visualizer?.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("CLI plan-only mode writes a graph without worker execution", async () => {
  const dir = await mkdtemp(join(tmpdir(), "plan-only-cli-"));
  try {
    const graphPath = join(dir, "plan.graph.json");
    const markerPath = join(dir, "worker-ran.txt");
    const runnerPath = join(dir, "runner.mjs");
    await writeFile(runnerPath, `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(markerPath)}, "ran");\n`, "utf8");

    const cli = await execFileAsync(process.execPath, [
      schedulerScriptPath,
      "plan",
      "--goal",
      "Review before execution",
      "--graph",
      graphPath,
      "--plan-only",
      "--codex-command",
      process.execPath,
      "--codex-arg",
      runnerPath
    ]);
    const result = JSON.parse(cli.stdout);
    assert.equal(result.mode, "plan-only");
    assert.equal(result.written, true);
    assert.equal(result.execution, undefined);
    assert.equal(existsSync(graphPath), true);
    assert.equal(existsSync(markerPath), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("CLI plan-then-run writes the graph and reuses worker execution", async () => {
  const dir = await mkdtemp(join(tmpdir(), "plan-then-run-cli-"));
  try {
    const graphPath = join(dir, "plan.graph.json");
    const markerPath = join(dir, "worker-ran.txt");
    const runnerPath = join(dir, "runner.mjs");
    await writeFile(
      runnerPath,
      `import { writeFileSync } from "node:fs";\nconst prompt = process.argv.at(-1) || "";\nwriteFileSync(${JSON.stringify(markerPath)}, prompt.includes("Node: PLAN") ? "PLAN" : "missing");\nconsole.log("worker finished");\n`,
      "utf8"
    );

    const cli = await execFileAsync(process.execPath, [
      schedulerScriptPath,
      "plan",
      "--goal",
      "Run immediately",
      "--graph",
      graphPath,
      "--then-run",
      "--once",
      "--session",
      "plan-runner",
      "--cwd",
      dir,
      "--codex-command",
      process.execPath,
      "--codex-arg",
      runnerPath
    ]);
    const result = JSON.parse(cli.stdout);
    assert.equal(result.mode, "plan-then-run");
    assert.equal(result.written, true);
    assert.equal(result.execution.session, "plan-runner");
    assert.equal(result.execution.idle, false);
    assert.equal(result.execution.results[0].nodeId, "PLAN");
    assert.equal(result.execution.results[0].code, 0);
    assert.equal(existsSync(markerPath), true);

    const graph = await readGraph(graphPath);
    assert.equal(graph.graph.nodes.PLAN.status, "done");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("CLI plan-then-run keeps the generated graph when execution setup fails", async () => {
  const dir = await mkdtemp(join(tmpdir(), "plan-then-run-fails-cli-"));
  try {
    const graphPath = join(dir, "plan.graph.json");
    await assert.rejects(
      execFileAsync(process.execPath, [
        schedulerScriptPath,
        "plan",
        "--goal",
        "Keep graph after execution failure",
        "--graph",
        graphPath,
        "--then-run",
        "--once",
        "--isolation",
        "invalid"
      ]),
      (error) => {
        const result = JSON.parse(error.stdout);
        assert.equal(result.graphPath, graphPath);
        assert.equal(result.written, true);
        assert.equal(result.execution.failed, true);
        assert.match(result.execution.error, /Invalid --isolation/);
        return true;
      }
    );
    assert.equal(existsSync(graphPath), true);
    const graph = await readGraph(graphPath);
    assert.equal(graph.graph.root, "ROOT");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("CLI plan dry-run output is a replayable generated graph", async () => {
  const dir = await mkdtemp(join(tmpdir(), "plan-dry-run-replay-"));
  try {
    const graphPath = join(dir, "nested", "dry-run.graph.json");
    const cli = await execFileAsync(process.execPath, [
      schedulerScriptPath,
      "plan",
      "--goal",
      "Preview replayable graph",
      "--title",
      "Preview Replay Plan",
      "--graph",
      graphPath,
      "--dry-run"
    ]);
    const result = JSON.parse(cli.stdout);

    assert.equal(result.mode, "plan-only");
    assert.equal(result.dryRun, true);
    assert.equal(result.written, false);
    assert.equal(existsSync(graphPath), false);
    assert.deepEqual(validatePlanGraphFileResult(result.graph).errors, []);

    await mkdir(dirname(graphPath), { recursive: true });
    await writeFile(graphPath, `${JSON.stringify(result.graph, null, 2)}\n`, "utf8");

    const summary = JSON.parse((await execFileAsync(process.execPath, [schedulerScriptPath, "summary", "--graph", graphPath])).stdout);
    assert.equal(summary.totalNodes, 2);
    assert.equal(summary.root, "ROOT");
    assert.deepEqual(summary.counts, { pending: 2 });

    const ready = JSON.parse((await execFileAsync(process.execPath, [schedulerScriptPath, "ready", "--graph", graphPath])).stdout);
    assert.deepEqual(ready.map((node) => node.id), ["PLAN"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("generated plan-only graph replays through the worker command", async () => {
  const dir = await mkdtemp(join(tmpdir(), "generated-plan-replay-"));
  try {
    const graphPath = join(dir, "plan.graph.json");
    const markerPath = join(dir, "replay-worker-ran.txt");
    const runnerPath = join(dir, "replay-runner.mjs");
    await writeFile(
      runnerPath,
      `import { writeFileSync } from "node:fs";\nconst prompt = process.argv.at(-1) || "";\nwriteFileSync(${JSON.stringify(markerPath)}, prompt.includes("Node: PLAN") ? "PLAN" : "missing");\nconsole.log("replay worker completed");\n`,
      "utf8"
    );

    const plan = JSON.parse((await execFileAsync(process.execPath, [
      schedulerScriptPath,
      "plan",
      "--goal",
      "Replay generated graph",
      "--graph",
      graphPath,
      "--plan-only"
    ])).stdout);
    assert.equal(plan.mode, "plan-only");
    assert.equal(plan.written, true);

    const firstRun = JSON.parse((await execFileAsync(process.execPath, [
      schedulerScriptPath,
      "worker",
      "--graph",
      graphPath,
      "--session",
      "generated-replay",
      "--once",
      "--quiet",
      "--cwd",
      dir,
      "--codex-command",
      process.execPath,
      "--codex-arg",
      runnerPath
    ])).stdout);
    assert.equal(firstRun.idle, false);
    assert.equal(firstRun.results[0].nodeId, "PLAN");
    assert.equal(firstRun.results[0].status, "done");
    assert.equal(existsSync(markerPath), true);

    const graph = await readGraph(graphPath);
    assert.equal(graph.graph.nodes.PLAN.status, "done");

    const events = JSON.parse((await execFileAsync(process.execPath, [
      schedulerScriptPath,
      "events",
      "--graph",
      graphPath,
      "--node",
      "PLAN",
      "--limit",
      "5"
    ])).stdout);
    assert.deepEqual(events.slice(0, 3).map((event) => event.event), ["done", "running", "claimed"]);

    const replayIdle = JSON.parse((await execFileAsync(process.execPath, [
      schedulerScriptPath,
      "worker",
      "--graph",
      graphPath,
      "--session",
      "generated-replay",
      "--once",
      "--quiet",
      "--cwd",
      dir,
      "--codex-command",
      process.execPath,
      "--codex-arg",
      runnerPath
    ])).stdout);
    assert.equal(replayIdle.idle, true);
    assert.deepEqual(replayIdle.results, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("generated goal fixture resumes after releasing an expired worker lease", async () => {
  const { dir, graphPath } = await copyGraphFixtureToTemp("valid-generated-goal.graph.json");
  try {
    const claim = JSON.parse((await execFileAsync(process.execPath, [
      schedulerScriptPath,
      "claim",
      "--graph",
      graphPath,
      "--node",
      "PLAN",
      "--session",
      "stale-generated-worker",
      "--lease",
      "1"
    ])).stdout);
    await execFileAsync(process.execPath, [
      schedulerScriptPath,
      "start",
      "--graph",
      graphPath,
      "--node",
      "PLAN",
      "--session",
      "stale-generated-worker",
      "--run",
      claim.runId
    ]);

    const staleGraph = await readGraph(graphPath);
    staleGraph.graph.nodes.PLAN.lease.expiresAt = "2026-05-27T00:00:01.000Z";
    await writeFile(graphPath, `${JSON.stringify(staleGraph, null, 2)}\n`, "utf8");

    const release = JSON.parse((await execFileAsync(process.execPath, [
      schedulerScriptPath,
      "release-expired",
      "--graph",
      graphPath
    ])).stdout);
    assert.deepEqual(release.released, ["PLAN"]);

    const ready = JSON.parse((await execFileAsync(process.execPath, [schedulerScriptPath, "ready", "--graph", graphPath])).stdout);
    assert.deepEqual(ready.map((node) => node.id), ["PLAN"]);

    const runnerPath = join(dir, "resume-runner.mjs");
    await writeFile(runnerPath, "console.log('resumed generated fixture');\n", "utf8");
    const resumed = JSON.parse((await execFileAsync(process.execPath, [
      schedulerScriptPath,
      "worker",
      "--graph",
      graphPath,
      "--session",
      "generated-resume",
      "--once",
      "--quiet",
      "--cwd",
      dir,
      "--codex-command",
      process.execPath,
      "--codex-arg",
      runnerPath
    ])).stdout);
    assert.equal(resumed.idle, false);
    assert.equal(resumed.results[0].nodeId, "PLAN");
    assert.equal(resumed.results[0].status, "done");

    const graph = await readGraph(graphPath);
    assert.equal(graph.graph.nodes.PLAN.status, "done");
    assert.equal(graph.graph.nodes.PLAN.history.some((event) => event.event === "expired"), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("CLI keeps graph mutation when Slack delivery fails", async () => {
  const server = createServer((_request, response) => {
    response.writeHead(500, { "content-type": "text/plain" });
    response.end("boom");
  });

  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  try {
    const { port } = server.address();
    await withTempGraph(async (graphPath) => {
      await claimNode(graphPath, { session: "codex-A", nodeId: "A" });
      const cli = await execFileAsync(process.execPath, [
        schedulerScriptPath,
        "done",
        "--graph",
        graphPath,
        "--node",
        "A",
        "--session",
        "codex-A",
        "--report",
        "reports/A.md"
      ], { env: { ...process.env, SLACK_WEBHOOK_URL: `http://127.0.0.1:${port}/slack` } });
      const result = JSON.parse(cli.stdout);
      assert.deepEqual(result.slack, {
        failed: true,
        reason: "Slack notification failed: HTTP 500"
      });
      const graph = await readGraph(graphPath);
      assert.equal(graph.graph.nodes.A.status, "done");
      assert.equal(graph.graph.nodes.A.report, "reports/A.md");
    });
  } finally {
    await new Promise((resolveClose, rejectClose) => {
      server.close((error) => error ? rejectClose(error) : resolveClose());
    });
  }
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
    },
    {
      command: "apply-preview",
      prepare: async (graphPath) => {
        const claim = await claimNode(graphPath, { session: "codex-A", nodeId: "A" });
        await blockNode(graphPath, {
          nodeId: "A",
          session: "codex-A",
          runId: claim.runId,
          question: "Approve planner preview?",
          plannerPreview: {
            requestId: "command-shape-apply-preview",
            proposedKind: "series",
            childIds: ["A_PREVIEW"],
            response: { kind: "series", title: "Apply preview", children: [{ id: "A_PREVIEW", title: "Preview child" }] },
            decompose: { kind: "series", children: [{ id: "A_PREVIEW", title: "Preview child" }] }
          }
        });
        return claim;
      },
      args: ["apply-preview", "--node", "A", "--session", "codex-A"]
    },
    {
      command: "reject-preview",
      prepare: async (graphPath) => {
        const claim = await claimNode(graphPath, { session: "codex-A", nodeId: "A" });
        await blockNode(graphPath, {
          nodeId: "A",
          session: "codex-A",
          runId: claim.runId,
          question: "Approve planner preview?",
          plannerPreview: {
            requestId: "command-shape-reject-preview",
            proposedKind: "parallel",
            childIds: ["A_REJECTED"],
            response: { kind: "parallel", title: "Reject preview", children: [{ id: "A_REJECTED", title: "Rejected child" }] },
            decompose: { kind: "parallel", children: [{ id: "A_REJECTED", title: "Rejected child" }] }
          }
        });
      },
      args: ["reject-preview", "--node", "A", "--reason", "too broad"]
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

  await withTempGraph(async (graphPath) => {
    await execFileAsync(process.execPath, [
      schedulerScriptPath,
      "claim",
      "--graph",
      graphPath,
      "--node",
      "A",
      "--session",
      "codex-custom"
    ]);
    await execFileAsync(process.execPath, [
      schedulerScriptPath,
      "decompose",
      "--graph",
      graphPath,
      "--node",
      "A",
      "--session",
      "codex-custom",
      "--kind",
      "parallel",
      "--child",
      "custom path/api:1=Custom CLI child",
      "--child",
      "custom/path:2=Second custom CLI child"
    ]);

    const graph = await readGraph(graphPath);
    assert.deepEqual(graph.graph.nodes.A.children, ["custom path/api:1", "custom/path:2"]);
    assert.equal(graph.graph.nodes["custom path/api:1"].title, "Custom CLI child");
    assert.deepEqual(validatePlanGraphFileResult(graph).errors, []);
  });

  await withTempGraph(async (graphPath) => {
    await execFileAsync(process.execPath, [
      schedulerScriptPath,
      "claim",
      "--graph",
      graphPath,
      "--node",
      "A",
      "--session",
      "codex-json"
    ]);
    await execFileAsync(process.execPath, [
      schedulerScriptPath,
      "decompose",
      "--graph",
      graphPath,
      "--node",
      "A",
      "--session",
      "codex-json",
      "--kind",
      "parallel",
      "--child-json",
      "[{\"id\":\"custom/path:json\",\"title\":\"Custom JSON child\"},{\"id\":\"custom json:2\",\"title\":\"Second JSON child\"}]"
    ]);

    const graph = await readGraph(graphPath);
    assert.deepEqual(graph.graph.nodes.A.children, ["custom/path:json", "custom json:2"]);
    assert.equal(graph.graph.nodes["custom/path:json"].title, "Custom JSON child");
    assert.deepEqual(validatePlanGraphFileResult(graph).errors, []);
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
    parseChildrenArgs({ "child-json": "[{\"id\":\"A1\",\"title\":\"First\",\"children\":[\"A1a\"],\"ownerMetadata\":{\"retained\":true}}]" }),
    [{ id: "A1", title: "First", ownerMetadata: { retained: true }, children: ["A1a"] }]
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

test("CLI help lists commands, flag kinds, defaults, environment variables, and examples", async () => {
  const help = renderCliHelp();
  const commandNames = [
    "plan",
    "ready",
    "summary",
    "events",
    "claim",
    "start",
    "renew",
    "reset",
    "reset-subtree",
    "reset-reachable",
    "done",
    "block",
    "answer",
    "fail",
    "decompose",
    "apply-preview",
    "reject-preview",
    "prompt",
    "worker",
    "reconcile",
    "release-expired",
    "serve"
  ];
  for (const commandName of commandNames) {
    assert.match(help, new RegExp(`\\n {2}${commandName}\\n`));
  }

  assert.match(help, /--graph PATH\s+Optional for every command\. Default: PLAN_GRAPH, then plan\.graph\.json\./);
  assert.match(help, /Boolean flags take no value: --help, --dry-run, --plan-only, --then-run, --once, --quiet, --unsafe-visualizer-write\./);
  assert.match(help, /Repeatable flags: --child ID=Title or ID:Title; --codex-arg ARG; --planner-allowed-kind task\|series\|parallel\./);
  assert.match(help, /Use --codex-arg=--flag when the value starts with "-"\./);
  assert.match(help, /--lease 1\.\.86400 seconds, --idle-ms 1\.\.86400000, --timeout-ms 1\.\.86400000, --port 0\.\.65535, --limit 1\.\.10000/);
  assert.match(help, /Path flags: --graph selects the graph; for plan only, --graph is the output graph path\. --report stays inside the graph directory; --template and --planner-template resolve from the graph directory; --planner-fixture resolves from the graph directory; --cwd controls worker process cwd\./);
  assert.match(help, /PLAN_GRAPH\s+Default graph path when --graph is omitted\./);
  assert.match(help, /SLACK_WEBHOOK_URL\s+Enables notifications for done, block, answer, fail, decompose, apply-preview, and reject-preview\./);
  assert.match(help, /SPG_SLACK_TIMEOUT_MS\s+Slack notification timeout in milliseconds\. Default: 5000\./);
  assert.match(help, /SPG_DEBUG=1\s+Include stack traces in CLI errors\./);
  assert.match(help, /SPG_GRAPH_LOCK_TIMEOUT_MS\s+Graph lock wait timeout in milliseconds\. Default: 5000\./);
  assert.match(help, /SPG_GIT_CACHE_LOCK_TIMEOUT_MS\s+Git cache lock wait timeout in milliseconds\. Default: 60000\./);
  assert.match(help, /Required: --node ID, --answer TEXT/);
  assert.match(help, /Required: --goal TEXT/);
  assert.match(help, /--graph PATH \(output graph path\), --title TEXT, --dry-run, --plan-only, --then-run/);
  assert.match(help, /--child ID=Title repeated, or --child-json JSON/);
  assert.match(help, /--session NAME \(default: codex-worker\)/);
  assert.match(help, /--codex-command PATH \(default: codex\), --codex-arg ARG repeated \(default: exec\)/);
  assert.match(help, /--isolation off\|git \(default: off\)/);
  assert.match(help, /--remote URL \(default: scheduler\.remote\)/);
  assert.match(help, /--workspace-root PATH \(default: runs\/workspaces\)/);
  assert.match(help, /--workspace-retention on-failure\|always\|never \(default: on-failure\)/);
  assert.match(help, /Isolation flags: --isolation git requires scheduler\.remote unless --remote URL is supplied/);
  assert.match(help, /Example: node scripts\/plan-scheduler\.mjs worker --graph plan\.graph\.json --session codex-A --once/);

  const cliHelp = await execFileAsync(process.execPath, [schedulerScriptPath, "ready", "--help"]);
  assert.equal(cliHelp.stdout, `${help}\n`);
});

test("worker isolation remote resolution prefers CLI remote and rejects placeholders", async () => {
  await withTempGraph(async (graphPath, dir) => {
    const graph = fixtureGraph();
    graph.scheduler.remote = "git@example.com:org/graph.git";

    assert.deepEqual(resolveWorkerIsolation(graphPath, graph, { isolation: "git" }), {
      mode: "git",
      remote: "git@example.com:org/graph.git",
      redactedRemote: "git@example.com:org/graph.git",
      remoteSource: "scheduler.remote",
      bareRepoPath: join(dir, "runs/git/cache/repo.git"),
      workspaceRoot: join(dir, "runs/workspaces"),
      workspaceRetention: "on-failure"
    });

    assert.deepEqual(resolveWorkerIsolation(graphPath, graph, {
      isolation: "git",
      remote: "https://user:token@example.com/org/cli.git",
      workspaceRoot: "custom-workspaces",
      workspaceRetention: "always"
    }), {
      mode: "git",
      remote: "https://user:token@example.com/org/cli.git",
      redactedRemote: "https://[REDACTED]@example.com/org/cli.git",
      remoteSource: "--remote",
      bareRepoPath: join(dir, "runs/git/cache/repo.git"),
      workspaceRoot: join(dir, "custom-workspaces"),
      workspaceRetention: "always"
    });

    assert.deepEqual(resolveWorkerIsolation(graphPath, graph, { isolation: "off" }), { mode: "off" });

    assert.throws(
      () => resolveWorkerIsolation(graphPath, fixtureGraph(), { isolation: "git" }),
      /Worker isolation requires scheduler\.remote; set graph\.scheduler\.remote or pass --remote <url> with --isolation git\./
    );
    assert.throws(
      () => resolveWorkerIsolation(graphPath, { ...fixtureGraph(), scheduler: { remote: "REQUIRED: set to the Git remote URL" } }, { isolation: "git" }),
      /Worker isolation remote is a placeholder and cannot be used: REQUIRED: set to the Git remote URL/
    );
    assert.throws(
      () => resolveWorkerIsolation(graphPath, graph, { isolation: "git", workspaceRoot: "../outside" }),
      /Invalid --workspace-root: path must stay inside the graph directory/
    );
    assert.throws(
      () => resolveWorkerIsolation(graphPath, graph, { isolation: "git", workspaceRetention: "sometimes" }),
      /Invalid --workspace-retention: expected on-failure, always, or never/
    );
  });
});

test("prompt command renders an external template", async () => {
  await withTempGraph(async (graphPath, dir) => {
    const templatePath = join(dir, "task-template.md");
    await writeFile(
      templatePath,
      "Session={{session}} Node={{nodeId}} Title={{nodeTitle}} Plan={{planTitle}} Description={{planDescription}} Report={{reportPath}} Missing={{missingVariable}}\n",
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
    assert.match(prompt, /Missing=\{\{missingVariable\}\}/);

    const relativePrompt = await buildWorkerPrompt(graphPath, {
      nodeId: "A",
      session: "codex-A",
      runId: "run-test",
      templatePath: "task-template.md",
      reportPath: "reports/A.md"
    });
    assert.equal(relativePrompt, prompt);

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
            assert.doesNotMatch(stderr, /\n\s+at /);
            return true;
          }
        );
      });
    });
  }
});

test("scheduler CLI keeps JSON stdout clean for expected failures", async () => {
  await withTempGraph(async (graphPath) => {
    await assertCliFails(
      ["done", "--graph", graphPath, "--node", "A"],
      /Cannot complete node from status pending/
    );

    const graph = fixtureGraph();
    delete graph.graph.root;
    await writeFile(graphPath, `${JSON.stringify(graph, null, 2)}\n`, "utf8");
    await assertCliFails(
      ["ready", "--graph", graphPath],
      /Invalid graph file/
    );

    await writeFile(graphPath, `${JSON.stringify(fixtureGraph(), null, 2)}\n`, "utf8");
    const lockPath = `${graphPath}.lock`;
    await mkdir(lockPath);
    await writeFile(
      join(lockPath, "metadata.json"),
      `${JSON.stringify({
        pid: 24680,
        createdAt: "2026-05-27T02:00:00.000Z",
        graphPath,
        host: "cli-test-host"
      })}\n`,
      "utf8"
    );
    await assertCliFails(
      ["release-expired", "--graph", graphPath],
      /Timed out waiting for graph lock:/,
      { env: { ...process.env, SPG_GRAPH_LOCK_TIMEOUT_MS: "20" } }
    );
  });
});

test("scheduler CLI emits stacks only in explicit debug mode", async () => {
  await withTempGraph(async (graphPath) => {
    await assert.rejects(
      execFileAsync(process.execPath, [schedulerScriptPath, "worker", "--graph", graphPath, "--once", "false"], {
        env: { ...process.env, SPG_DEBUG: "1" }
      }),
      (error) => {
        assert.equal(error.stdout, "");
        assert.match(error.stderr, /Boolean flag --once does not accept a value; received "false"/);
        assert.match(error.stderr, /\n\s+at parseArgs/);
        return true;
      }
    );
  });
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
            assert.doesNotMatch(stderr, /\n\s+at /);
            return true;
          }
        );
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  }
});
