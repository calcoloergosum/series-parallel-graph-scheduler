import test from "node:test";
import { assert, assertCliFails, applyPlannerPreview, blockNode, buildNodeWorkBranchName, buildWorkerPrompt, claimNode, collectGitDiffStat, completeNode, copyGraphFixtureToTemp, createFixturePlannerRuntime, createRawWorkerManager, createRunClone, createSourceBranch, createWorkBranch, decomposeNode, depthPriorityGraph, dirname, escapeRegExp, execFileAsync, existsSync, failNode, exportOperationalEvents, fixtureGraph, formatWorkerReport, gitShow, join, knownTransitionStatuses, lastHistory, listReadyLeafNodes, mkdir, mkdtemp, normalizeWorkerReport, operationalEvents, parallelWorkerIsolationGraph, parseCodexArgs, prepareBareRepository, prepareCompositionBareRepository, publishOutputRef, readFile, readGraph, readyIds, realpath, reconcileGraphStatus, recordWorkerRefMetadata, rejectPlannerPreview, releaseExpiredLeases, renewNodeLease, resetSubtree, resolveNodeBaseRef, rm, runCodexPrompt, runGitCommand, runWorker, schedulerScriptPath, schedulerTransitionTable, setNodeStatus, startLeaseHeartbeat, startNode, tmpdir, waitFor, withLocalBareRemote, withTempGraph, writeCommittingWorkerRunner, writeFile, writeNoopWorkerRunner, writeWorkerIsolationGraph } from "./helpers/plan-scheduler-harness.mjs";

test("worker report formatting includes auditable fields and stable volatile normalization", () => {
  const report = normalizeWorkerReport(formatWorkerReport({
    claim: {
      nodeId: "A\n## forged",
      title: "Bootstrap\n- fake list",
      runId: "run-1"
    },
    node: {
      baseRef: { name: "refs/remotes/origin/main", commit: "0123456789abcdef" },
      workRef: { name: "refs/heads/spg/node/A/run-1" },
      outputRef: { name: "refs/heads/spg/node/A/run-1", commit: "fedcba9876543210" },
      integrationRef: {
        name: "refs/heads/spg/integration/P/run-parent",
        status: "conflicted",
        inputRefs: [{ nodeId: "LEFT", outputRef: "refs/heads/spg/node/LEFT/run-left" }]
      },
      history: [
        {
          at: "2026-05-27T01:02:03.000Z",
          event: "clone-prepared",
          remote: "https://user:token@example.invalid/repo.git",
          bareRepo: "/tmp/repo.git",
          cloneCwd: "/tmp/work",
          baseRef: "refs/remotes/origin/main"
        },
        {
          at: "2026-05-27T01:02:03.500Z",
          event: "merge-conflicted",
          childId: "LEFT",
          childOutputRef: "refs/heads/spg/node/LEFT/run-left"
        }
      ]
    },
    run: {
      code: 7,
      signal: null,
      stdout: "before\n```text\n# not a heading\n```\nafter",
      stderr: "stderr line\nSLACK_WEBHOOK_URL=https://hooks.slack.com/services/T000/B000/SECRET",
      error: "spawn failed\n## not a heading",
      command: "codex\nexec",
      args: ["exec", "--token=super-secret"],
      cwd: "/tmp/work",
      startedAt: "2026-05-27T01:02:03.004Z",
      finishedAt: "2026-05-27T01:02:04.005Z",
      durationMs: 1001
    },
    finalState: {
      status: "running",
      stillOwned: true
    }
  }));

  assert.equal(report, `# A\\n## forged: Bootstrap\\n- fake list

- Node: A\\n## forged
- Run: run-1
- Exit code: 7
- Signal: none
- Command: codex\\nexec
- Args: ["exec","--token=[REDACTED]"]
- Cwd: /tmp/work
- Started: <iso-date>
- Finished: <iso-date>
- Duration ms: <duration-ms>
- Final graph status: running
- Lease still owned at finalization: true

## Isolation

- Worker cwd: /tmp/work
- Remote: https://[REDACTED]@example.invalid/repo.git
- Bare repository: /tmp/repo.git
- Clone cwd: /tmp/work
- Base ref: refs/remotes/origin/main
- Base commit: 0123456789abcdef
- Work branch/ref: refs/heads/spg/node/A/run-1
- Output ref: refs/heads/spg/node/A/run-1
- Output commit: fedcba9876543210
- Integration ref: refs/heads/spg/integration/P/run-parent
- Integration status: conflicted
- Merge refs: LEFT: refs/heads/spg/node/LEFT/run-left
- Conflicted merge refs: LEFT: refs/heads/spg/node/LEFT/run-left

## Stdout

\`\`\`\`text
before
\`\`\`text
# not a heading
\`\`\`
after
\`\`\`\`

## Stderr

\`\`\`text
stderr line
SLACK_WEBHOOK_URL=[REDACTED]
\`\`\`

## Error

\`\`\`text
spawn failed
## not a heading
\`\`\``);
  assert.doesNotMatch(report, /user:token|super-secret|T000\/B000\/SECRET/);
});

test("concurrent explicit claims allow only one worker to claim a ready leaf", async () => {
  await withTempGraph(async (graphPath) => {
    const attempts = Array.from({ length: 10 }, (_, index) =>
      claimNode(graphPath, { nodeId: "A", session: `same-leaf-${index}` })
    );
    const results = await Promise.allSettled(attempts);
    const claimed = results
      .filter((result) => result.status === "fulfilled")
      .map((result) => result.value);
    const rejected = results.filter((result) => result.status === "rejected");

    assert.equal(claimed.length, 1, `Expected exactly one explicit claim for ${graphPath}`);
    assert.equal(claimed[0].nodeId, "A");
    assert.equal(rejected.length, 9);
    for (const result of rejected) {
      assert.match(result.reason.message, /Node is not ready to claim: A/);
    }

    const graph = await readGraph(graphPath);
    assert.equal(graph.graph.nodes.A.status, "claimed");
    assert.equal(graph.graph.nodes.A.lease.session, claimed[0].lease.session);
    assert.equal(graph.graph.nodes.A.history.filter((entry) => entry.event === "claimed").length, 1);
  });
});

test("worker ref metadata records workspace provenance and output refs", async () => {
  await withTempGraph(async (graphPath) => {
    const claim = await claimNode(graphPath, { session: "codex-A", nodeId: "A" });
    await startNode(graphPath, { nodeId: "A", session: "codex-A", runId: claim.runId });

    await recordWorkerRefMetadata(graphPath, {
      nodeId: "A",
      session: "codex-A",
      runId: claim.runId,
      refMetadata: {
        remote: "https://user:token@example.com/org/repo.git",
        bareRepo: "/tmp/graph/runs/git/cache/repo.git",
        cloneCwd: "/tmp/graph/runs/workspaces/codex-A/A/run-1",
        baseRef: {
          name: "refs/remotes/origin/main",
          commit: "0123456789abcdef0123456789abcdef01234567",
          source: "graph-default"
        },
        workRef: {
          name: "refs/heads/spg/node/A/run-1",
          commit: "1111111111111111111111111111111111111111"
        },
        retained: true
      }
    });

    await completeNode(graphPath, {
      nodeId: "A",
      session: "codex-A",
      runId: claim.runId,
      report: "reports/A-run-1.md",
      refMetadata: {
        outputRef: {
          name: "refs/heads/spg/node/A/run-1",
          commit: "2222222222222222222222222222222222222222"
        }
      }
    });

    const graph = await readGraph(graphPath);
    const node = graph.graph.nodes.A;
    assert.equal(node.workspace.cloneCwd, "/tmp/graph/runs/workspaces/codex-A/A/run-1");
    assert.equal(node.workspace.remote, "https://[REDACTED]@example.com/org/repo.git");
    assert.equal(node.workspace.bareRepo, "/tmp/graph/runs/git/cache/repo.git");
    assert.equal(node.workspace.retained, true);
    assert.equal(node.baseRef.name, "refs/remotes/origin/main");
    assert.equal(node.workRef.name, "refs/heads/spg/node/A/run-1");
    assert.equal(node.workRef.runId, claim.runId);
    assert.equal(node.outputRef.name, "refs/heads/spg/node/A/run-1");
    assert.equal(node.outputRef.report, "reports/A-run-1.md");

    const historyEvents = node.history.map((entry) => entry.event);
    assert.ok(historyEvents.includes("clone-prepared"));
    assert.ok(historyEvents.includes("branch-created"));
    assert.ok(historyEvents.includes("output-ref-recorded"));
    assert.doesNotMatch(JSON.stringify(node), /user:token/);
  });
});

test("base-ref resolver follows graph defaults, series predecessors, and parallel parent bases", () => {
  const graph = {
    graphVersion: 1,
    scheduler: {
      baseRef: {
        name: "refs/remotes/origin/main",
        commit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
      }
    },
    graph: {
      root: "ROOT",
      nodes: {
        ROOT: { title: "Root", kind: "series", status: "pending", children: ["SETUP", "FANOUT"] },
        SETUP: {
          title: "Setup",
          kind: "task",
          status: "done",
          outputRef: {
            name: "refs/heads/spg/node/SETUP/run-setup",
            commit: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
          }
        },
        FANOUT: { title: "Fanout", kind: "parallel", status: "pending", children: ["LEFT", "RIGHT", "OVERRIDE"] },
        LEFT: { title: "Left series", kind: "series", status: "pending", children: ["L1", "L2"] },
        L1: {
          title: "Left first",
          kind: "task",
          status: "done",
          outputRef: {
            name: "refs/heads/spg/node/L1/run-l1",
            commit: "cccccccccccccccccccccccccccccccccccccccc"
          }
        },
        L2: { title: "Left second", kind: "task", status: "pending" },
        RIGHT: { title: "Right", kind: "task", status: "pending" },
        OVERRIDE: {
          title: "Override",
          kind: "task",
          status: "pending",
          baseRef: { name: "refs/heads/custom-base" }
        }
      }
    }
  };

  assert.deepEqual(resolveNodeBaseRef(graph, "SETUP"), {
    name: "refs/remotes/origin/main",
    commit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    source: "graph-default"
  });
  assert.deepEqual(resolveNodeBaseRef(graph, "FANOUT"), {
    name: "refs/heads/spg/node/SETUP/run-setup",
    commit: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    source: "series-predecessor",
    predecessorId: "SETUP"
  });
  assert.equal(resolveNodeBaseRef(graph, "LEFT").name, "refs/heads/spg/node/SETUP/run-setup");
  assert.equal(resolveNodeBaseRef(graph, "LEFT").source, "parent-base");
  assert.deepEqual(resolveNodeBaseRef(graph, "RIGHT"), resolveNodeBaseRef(graph, "LEFT"));
  assert.deepEqual(resolveNodeBaseRef(graph, "OVERRIDE"), {
    name: "refs/heads/custom-base",
    source: "explicit"
  });
  assert.equal(resolveNodeBaseRef(graph, "L1").name, "refs/heads/spg/node/SETUP/run-setup");
  assert.deepEqual(resolveNodeBaseRef(graph, "L2"), {
    name: "refs/heads/spg/node/L1/run-l1",
    commit: "cccccccccccccccccccccccccccccccccccccccc",
    source: "series-predecessor",
    predecessorId: "L1"
  });
});

test("isolated claim refuses downstream series work with an unknown predecessor output ref", async () => {
  await withTempGraph(async (graphPath) => {
    const graph = {
      graphVersion: 1,
      scheduler: { leaseSeconds: 1, baseRef: "refs/remotes/origin/main" },
      graph: {
        root: "ROOT",
        nodes: {
          ROOT: { title: "Root", kind: "series", status: "pending", children: ["A", "B"] },
          A: { title: "First", kind: "task", status: "done" },
          B: { title: "Second", kind: "task", status: "pending" }
        }
      }
    };
    await writeFile(graphPath, `${JSON.stringify(graph, null, 2)}\n`, "utf8");

    await assert.rejects(
      claimNode(graphPath, { session: "codex-B", nodeId: "B", resolveBaseRef: true }),
      /Cannot resolve base ref for B: series predecessor A is missing outputRef\.name/
    );

    const after = await readGraph(graphPath);
    assert.equal(after.graph.nodes.B.status, "pending");
    assert.equal(after.graph.nodes.B.lease, undefined);
  });
});

test("isolated claims record the resolved base ref before worker start", async () => {
  await withTempGraph(async (graphPath) => {
    const graph = {
      graphVersion: 1,
      scheduler: { leaseSeconds: 1, baseRef: { name: "refs/remotes/origin/main" } },
      graph: {
        root: "ROOT",
        nodes: {
          ROOT: { title: "Root", kind: "series", status: "pending", children: ["A", "B"] },
          A: {
            title: "First",
            kind: "task",
            status: "done",
            outputRef: { name: "refs/heads/spg/node/A/run-a" }
          },
          B: { title: "Second", kind: "task", status: "pending" }
        }
      }
    };
    await writeFile(graphPath, `${JSON.stringify(graph, null, 2)}\n`, "utf8");

    const claim = await claimNode(graphPath, { session: "codex-B", nodeId: "B", resolveBaseRef: true });

    assert.equal(claim.baseRef.name, "refs/heads/spg/node/A/run-a");
    assert.equal(claim.baseRef.source, "series-predecessor");
    const after = await readGraph(graphPath);
    assert.equal(after.graph.nodes.B.baseRef.name, "refs/heads/spg/node/A/run-a");
    assert.equal(after.graph.nodes.B.baseRef.source, "series-predecessor");
    assert.match(after.graph.nodes.B.baseRef.resolvedAt, /^\d{4}-\d{2}-\d{2}T/);
  });
});

test("series reconciliation aliases the final child output ref as the parent output ref", async () => {
  await withTempGraph(async (graphPath) => {
    const graph = {
      graphVersion: 1,
      title: "Series Alias Plan",
      graph: {
        root: "ROOT",
        nodes: {
          ROOT: { title: "Root", kind: "series", status: "pending", children: ["SERIES", "DOWNSTREAM"] },
          SERIES: { title: "Series parent", kind: "series", status: "pending", children: ["S1", "S2"] },
          S1: {
            title: "First child",
            kind: "task",
            status: "done",
            outputRef: {
              name: "refs/heads/spg/node/S1/run-s1",
              commit: "1111111111111111111111111111111111111111",
              diffStat: { filesChanged: 1, additions: 1, deletions: 0, totalChanges: 1 },
              files: [{ path: "shared.txt", changeType: "modified", additions: 1, deletions: 0, totalChanges: 1 }]
            }
          },
          S2: {
            title: "Final child",
            kind: "task",
            status: "done",
            outputRef: {
              name: "refs/heads/spg/node/S2/run-s2",
              commit: "2222222222222222222222222222222222222222",
              runId: "run-s2",
              session: "codex-S2",
              report: "reports/S2-run-s2.md",
              diffStat: { filesChanged: 2, additions: 5, deletions: 1, totalChanges: 6 },
              files: [
                { path: "final.txt", changeType: "modified", additions: 3, deletions: 0, totalChanges: 3 },
                { path: "shared.txt", changeType: "modified", additions: 2, deletions: 1, totalChanges: 3 }
              ]
            }
          },
          DOWNSTREAM: { title: "Downstream", kind: "task", status: "pending" }
        }
      }
    };
    await writeFile(graphPath, `${JSON.stringify(graph, null, 2)}\n`, "utf8");

    assert.deepEqual(listReadyLeafNodes(graph).map((node) => node.id), []);

    const result = await reconcileGraphStatus(graphPath);
    assert.deepEqual(result.changed, ["SERIES"]);

    const reconciled = await readGraph(graphPath);
    const parent = reconciled.graph.nodes.SERIES;
    const finalChild = reconciled.graph.nodes.S2;
    assert.equal(parent.status, "done");
    assert.equal(parent.outputRef.name, "refs/heads/spg/node/S2/run-s2");
    assert.equal(parent.outputRef.commit, "2222222222222222222222222222222222222222");
    assert.equal(parent.outputRef.source, "series-alias");
    assert.equal(parent.outputRef.aliasOfNodeId, "S2");
    assert.equal(parent.outputRef.runId, "run-s2");
    assert.equal(parent.outputRef.report, "reports/S2-run-s2.md");
    assert.equal(parent.integrationRef.kind, "series");
    assert.equal(parent.integrationRef.status, "clean");
    assert.equal(parent.integrationRef.publishedOutputRef, "refs/heads/spg/node/S2/run-s2");
    assert.equal(parent.gitFootprint.source, "child-aggregate");
    assert.equal(parent.gitFootprint.headRef.name, parent.outputRef.name);
    assert.deepEqual(parent.gitFootprint.diffStat, {
      filesChanged: 2,
      additions: 6,
      deletions: 1,
      totalChanges: 7
    });
    assert.equal(parent.gitFootprint.aggregation.diffStatKind, "summed-child-stats");
    assert.deepEqual(parent.gitFootprint.aggregation.duplicateFilePaths, ["shared.txt"]);
    assert.deepEqual(parent.integrationRef.inputRefs.map((input) => input.outputRef), [
      "refs/heads/spg/node/S1/run-s1",
      "refs/heads/spg/node/S2/run-s2"
    ]);
    assert.equal(finalChild.outputRef.name, "refs/heads/spg/node/S2/run-s2");
    assert.deepEqual(listReadyLeafNodes(reconciled).map((node) => node.id), ["DOWNSTREAM"]);

    const publishEvents = parent.history.filter((entry) => entry.event === "parent-ref-published");
    assert.equal(publishEvents.length, 1);
    assert.equal(publishEvents[0].kind, "series");
    assert.equal(publishEvents[0].finalChildId, "S2");

    assert.deepEqual((await reconcileGraphStatus(graphPath)).changed, []);
    const rereconciled = await readGraph(graphPath);
    assert.equal(
      rereconciled.graph.nodes.SERIES.history.filter((entry) => entry.event === "parent-ref-published").length,
      1
    );
  });
});

test("parallel reconciliation merges clean child output refs into a parent output ref", async () => {
  await withLocalBareRemote(async ({ dir, sourcePath, remotePath }) => {
    const graphDir = join(dir, "graph");
    const graphPath = join(graphDir, "plan.graph.json");
    await mkdir(graphDir);

    const leftOutput = await createSourceBranch({
      sourcePath,
      remotePath,
      branchName: "spg/node/A/run-clean-a",
      files: { "parallel-a.txt": "from A\n" },
      message: "parallel output A"
    });
    const rightOutput = await createSourceBranch({
      sourcePath,
      remotePath,
      branchName: "spg/node/B/run-clean-b",
      files: { "parallel-b.txt": "from B\n" },
      message: "parallel output B"
    });
    const bareRepoPath = await prepareCompositionBareRepository({ graphDir, remotePath });

    await writeFile(graphPath, `${JSON.stringify({
      graphVersion: 1,
      title: "Clean Parallel Integration Plan",
      scheduler: { remote: remotePath, baseRef: "refs/heads/main" },
      graph: {
        root: "P",
        nodes: {
          P: { title: "Parallel parent", kind: "parallel", status: "pending", children: ["A", "B"] },
          A: { title: "Branch A", kind: "task", status: "done", outputRef: leftOutput },
          B: { title: "Branch B", kind: "task", status: "done", outputRef: rightOutput }
        }
      }
    }, null, 2)}\n`, "utf8");

    const result = await reconcileGraphStatus(graphPath);
    assert.deepEqual(result.changed, ["P"]);

    const graph = await readGraph(graphPath);
    const parent = graph.graph.nodes.P;
    assert.equal(parent.status, "done");
    assert.equal(parent.outputRef.source, "parallel-integration");
    assert.match(parent.outputRef.name, /^refs\/heads\/spg\/integration\/P\/run_/);
    assert.equal(parent.outputRef.name, parent.integrationRef.publishedOutputRef);
    assert.equal(parent.integrationRef.status, "clean");
    assert.deepEqual(parent.integrationRef.inputRefs.map((input) => input.nodeId), ["A", "B"]);
    assert.deepEqual(parent.history.filter((entry) => entry.event === "merge-attempted").map((entry) => entry.childId), ["A", "B"]);

    assert.equal(await gitShow(bareRepoPath, parent.outputRef.name, "parallel-a.txt"), "from A\n");
    assert.equal(await gitShow(bareRepoPath, parent.outputRef.name, "parallel-b.txt"), "from B\n");

    const report = await readFile(join(graphDir, parent.report), "utf8");
    assert.match(report, /- Result: clean/);
    assert.match(report, new RegExp(`- 0: A -> ${escapeRegExp(leftOutput.name)}`));
    assert.match(report, new RegExp(`- 1: B -> ${escapeRegExp(rightOutput.name)}`));
  });
});

test("parallel reconciliation retries a missing-base block using the series predecessor output", async () => {
  await withLocalBareRemote(async ({ dir, sourcePath, remotePath }) => {
    const graphDir = join(dir, "graph");
    const graphPath = join(graphDir, "plan.graph.json");
    await mkdir(graphDir);

    const baselineOutput = await createSourceBranch({
      sourcePath,
      remotePath,
      branchName: "spg/node/BASELINE/run-baseline",
      files: { "baseline.txt": "baseline\n" },
      message: "baseline output"
    });
    const apiOutput = await createSourceBranch({
      sourcePath,
      remotePath,
      branchName: "spg/node/API/run-api",
      files: { "api.txt": "api\n" },
      message: "api output"
    });
    const uiOutput = await createSourceBranch({
      sourcePath,
      remotePath,
      branchName: "spg/node/UI/run-ui",
      files: { "ui.txt": "ui\n" },
      message: "ui output"
    });
    const bareRepoPath = await prepareCompositionBareRepository({ graphDir, remotePath });

    await writeFile(graphPath, JSON.stringify({
      graphVersion: 1,
      title: "Series Predecessor Parallel Integration Plan",
      scheduler: { remote: remotePath },
      graph: {
        root: "ROOT",
        nodes: {
          ROOT: { title: "Root", kind: "series", status: "pending", children: ["BASELINE", "IMPLEMENTATION", "FOLLOWUP"] },
          BASELINE: { title: "Baseline", kind: "task", status: "done", outputRef: baselineOutput },
          IMPLEMENTATION: {
            title: "Implementation",
            kind: "parallel",
            status: "blocked",
            children: ["API", "UI"],
            blockedAt: "2026-05-28T00:05:04.770Z",
            blockedReason: "parallel parent is missing baseRef.name",
            question: "Resolve parallel integration for IMPLEMENTATION; see reports/stale.md.",
            integrationRef: {
              name: "refs/heads/spg/integration/IMPLEMENTATION/run-stale",
              kind: "parallel",
              status: "pending",
              report: "reports/stale.md"
            }
          },
          API: { title: "API", kind: "task", status: "done", outputRef: apiOutput },
          UI: { title: "UI", kind: "task", status: "done", outputRef: uiOutput },
          FOLLOWUP: { title: "Follow-up", kind: "task", status: "pending" }
        }
      }
    }, null, 2) + "\n", "utf8");

    const result = await reconcileGraphStatus(graphPath);
    assert.deepEqual(result.changed, ["IMPLEMENTATION"]);

    const graph = await readGraph(graphPath);
    const parent = graph.graph.nodes.IMPLEMENTATION;
    assert.equal(parent.status, "done");
    assert.equal(parent.baseRef.name, baselineOutput.name);
    assert.equal(parent.baseRef.commit, baselineOutput.commit);
    assert.equal(parent.baseRef.source, "series-predecessor");
    assert.equal(parent.baseRef.predecessorId, "BASELINE");
    assert.equal(parent.blockedAt, undefined);
    assert.equal(parent.blockedReason, undefined);
    assert.equal(parent.question, undefined);
    assert.equal(parent.integrationRef.baseRef, baselineOutput.name);
    assert.equal(parent.outputRef.source, "parallel-integration");
    assert.deepEqual(readyIds(graph), ["FOLLOWUP"]);

    assert.equal(await gitShow(bareRepoPath, parent.outputRef.name, "baseline.txt"), "baseline\n");
    assert.equal(await gitShow(bareRepoPath, parent.outputRef.name, "api.txt"), "api\n");
    assert.equal(await gitShow(bareRepoPath, parent.outputRef.name, "ui.txt"), "ui\n");

    const report = await readFile(join(graphDir, parent.report), "utf8");
    assert.match(report, new RegExp("- Base ref: " + escapeRegExp(baselineOutput.name)));
  });
});

test("parallel reconciliation records conflicting child output refs for operator review", async () => {
  await withLocalBareRemote(async ({ dir, sourcePath, remotePath }) => {
    const graphDir = join(dir, "graph");
    const graphPath = join(graphDir, "plan.graph.json");
    await mkdir(graphDir);

    const leftOutput = await createSourceBranch({
      sourcePath,
      remotePath,
      branchName: "spg/node/A/run-conflict-a",
      files: { "shared-conflict.txt": "from A\n" },
      message: "conflicting output A"
    });
    const rightOutput = await createSourceBranch({
      sourcePath,
      remotePath,
      branchName: "spg/node/B/run-conflict-b",
      files: { "shared-conflict.txt": "from B\n" },
      message: "conflicting output B"
    });
    await prepareCompositionBareRepository({ graphDir, remotePath });

    await writeFile(graphPath, `${JSON.stringify({
      graphVersion: 1,
      title: "Conflicting Parallel Integration Plan",
      scheduler: { remote: remotePath, baseRef: "refs/heads/main" },
      graph: {
        root: "P",
        nodes: {
          P: { title: "Parallel parent", kind: "parallel", status: "pending", children: ["A", "B"] },
          A: { title: "Branch A", kind: "task", status: "done", outputRef: leftOutput },
          B: { title: "Branch B", kind: "task", status: "done", outputRef: rightOutput }
        }
      }
    }, null, 2)}\n`, "utf8");

    const result = await reconcileGraphStatus(graphPath);
    assert.deepEqual(result.changed, ["P"]);

    const graph = await readGraph(graphPath);
    const parent = graph.graph.nodes.P;
    assert.equal(parent.status, "review");
    assert.equal(parent.outputRef, undefined);
    assert.equal(parent.blockedReason, "parallel merge conflict");
    assert.equal(parent.integrationRef.status, "conflicted");
    assert.equal(parent.integrationRef.conflictedChildId, "B");
    assert.equal(parent.integrationRef.conflictedChildOrderIndex, 1);
    assert.deepEqual(parent.integrationRef.conflictedPaths, ["shared-conflict.txt"]);
    assert.deepEqual(parent.history.filter((entry) => entry.event === "merge-attempted").map((entry) => entry.childId), ["A", "B"]);

    const conflict = parent.history.find((entry) => entry.event === "merge-conflicted");
    assert.equal(conflict.childId, "B");
    assert.equal(conflict.childOutputRef, rightOutput.name);
    assert.equal(conflict.result, "review");

    const report = await readFile(join(graphDir, parent.report), "utf8");
    assert.match(report, /- Result: review/);
    assert.match(report, new RegExp(`- 0: A -> ${escapeRegExp(leftOutput.name)}`));
    assert.match(report, new RegExp(`- 1: B -> ${escapeRegExp(rightOutput.name)}`));
    assert.match(report, /## Failed merge/);
    assert.match(report, /- Child: B/);
    assert.match(report, /- shared-conflict\.txt/);
  });
});


test("worker resolves a retained integration conflict with Codex before idling", async () => {
  await withLocalBareRemote(async ({ dir, sourcePath, remotePath }) => {
    const graphDir = join(dir, "graph");
    const graphPath = join(graphDir, "plan.graph.json");
    await mkdir(graphDir);

    const leftOutput = await createSourceBranch({
      sourcePath,
      remotePath,
      branchName: "spg/node/A/run-worker-conflict-a",
      files: { "shared-conflict.txt": "from A\n" },
      message: "worker conflict output A"
    });
    const rightOutput = await createSourceBranch({
      sourcePath,
      remotePath,
      branchName: "spg/node/B/run-worker-conflict-b",
      files: { "shared-conflict.txt": "from B\n" },
      message: "worker conflict output B"
    });
    const bareRepoPath = await prepareCompositionBareRepository({ graphDir, remotePath });

    await writeFile(graphPath, JSON.stringify({
      graphVersion: 1,
      title: "Worker Conflict Resolution Plan",
      scheduler: { remote: remotePath, baseRef: "refs/heads/main" },
      graph: {
        root: "P",
        nodes: {
          P: { title: "Parallel parent", kind: "parallel", status: "pending", children: ["A", "B"] },
          A: { title: "Branch A", kind: "task", status: "done", outputRef: leftOutput },
          B: { title: "Branch B", kind: "task", status: "done", outputRef: rightOutput }
        }
      }
    }, null, 2) + "\n", "utf8");

    assert.deepEqual((await reconcileGraphStatus(graphPath)).changed, ["P"]);
    let graph = await readGraph(graphPath);
    assert.equal(graph.graph.nodes.P.status, "review");

    const resolverPath = join(dir, "fake-conflict-resolver.mjs");
    await writeFile(resolverPath, [
      "import { writeFileSync } from 'node:fs';",
      "writeFileSync('shared-conflict.txt', 'resolved by codex\\n');",
      "console.log('resolved retained integration conflict');"
    ].join("\n"), "utf8");

    const result = await runWorker(graphPath, {
      session: "codex-conflict",
      once: true,
      stream: false,
      codexCommand: process.execPath,
      codexArgs: [resolverPath]
    });

    assert.equal(result.idle, false);
    assert.equal(result.results[0].nodeId, "P");
    assert.equal(result.results[0].status, "done");
    assert.equal(result.results[0].code, 0);

    graph = await readGraph(graphPath);
    const parent = graph.graph.nodes.P;
    assert.equal(parent.status, "done");
    assert.equal(parent.integrationRef.status, "clean");
    assert.equal(parent.outputRef.name, parent.integrationRef.publishedOutputRef);
    assert.equal(await gitShow(bareRepoPath, parent.outputRef.name, "shared-conflict.txt"), "resolved by codex\n");

    const report = await readFile(join(graphDir, parent.report), "utf8");
    assert.match(report, /Integration conflict resolution: P/);
    assert.match(report, /resolved retained integration conflict/);
  });
});

test("nested series after parallel resolves downstream bases through parent output refs", async () => {
  await withLocalBareRemote(async ({ dir, sourcePath, remotePath }) => {
    const graphDir = join(dir, "graph");
    const graphPath = join(graphDir, "plan.graph.json");
    await mkdir(graphDir);

    const leftOutput = await createSourceBranch({
      sourcePath,
      remotePath,
      branchName: "spg/node/LEFT/run-nested-left",
      files: { "left.txt": "left\n" },
      message: "nested left output"
    });
    const rightOutput = await createSourceBranch({
      sourcePath,
      remotePath,
      branchName: "spg/node/RIGHT/run-nested-right",
      files: { "right.txt": "right\n" },
      message: "nested right output"
    });
    await prepareCompositionBareRepository({ graphDir, remotePath });

    await writeFile(graphPath, `${JSON.stringify({
      graphVersion: 1,
      title: "Nested Composition Integration Plan",
      scheduler: { remote: remotePath, baseRef: "refs/heads/main" },
      graph: {
        root: "ROOT",
        nodes: {
          ROOT: { title: "Root", kind: "series", status: "pending", children: ["FANOUT", "FOLLOWUP", "TAIL"] },
          FANOUT: { title: "Parallel fanout", kind: "parallel", status: "pending", children: ["LEFT", "RIGHT"] },
          LEFT: { title: "Left", kind: "task", status: "done", outputRef: leftOutput },
          RIGHT: { title: "Right", kind: "task", status: "done", outputRef: rightOutput },
          FOLLOWUP: { title: "Follow-up series", kind: "series", status: "pending", children: ["S1", "S2"] },
          S1: { title: "Series child one", kind: "task", status: "pending" },
          S2: { title: "Series child two", kind: "task", status: "pending" },
          TAIL: { title: "Tail", kind: "task", status: "pending" }
        }
      }
    }, null, 2)}\n`, "utf8");

    assert.deepEqual((await reconcileGraphStatus(graphPath)).changed, ["FANOUT"]);

    let graph = await readGraph(graphPath);
    const fanout = graph.graph.nodes.FANOUT;
    assert.equal(fanout.status, "done");
    assert.equal(fanout.outputRef.source, "parallel-integration");
    assert.deepEqual(readyIds(graph), ["S1"]);

    assert.deepEqual(resolveNodeBaseRef(graph, "S1"), {
      name: fanout.outputRef.name,
      commit: fanout.outputRef.commit,
      source: "parent-base",
      parentId: "FOLLOWUP",
      parentBaseSource: "series-predecessor"
    });

    graph.graph.nodes.S1.status = "done";
    graph.graph.nodes.S1.outputRef = {
      name: "refs/heads/spg/node/S1/run-s1",
      commit: "1111111111111111111111111111111111111111"
    };
    graph.graph.nodes.S2.status = "done";
    graph.graph.nodes.S2.outputRef = {
      name: "refs/heads/spg/node/S2/run-s2",
      commit: "2222222222222222222222222222222222222222",
      runId: "run-s2",
      report: "reports/S2-run-s2.md"
    };
    await writeFile(graphPath, `${JSON.stringify(graph, null, 2)}\n`, "utf8");

    assert.deepEqual((await reconcileGraphStatus(graphPath)).changed, ["FOLLOWUP"]);

    graph = await readGraph(graphPath);
    const followup = graph.graph.nodes.FOLLOWUP;
    assert.equal(followup.status, "done");
    assert.equal(followup.outputRef.name, "refs/heads/spg/node/S2/run-s2");
    assert.equal(followup.outputRef.source, "series-alias");
    assert.equal(followup.outputRef.aliasOfNodeId, "S2");
    assert.deepEqual(readyIds(graph), ["TAIL"]);
    assert.deepEqual(resolveNodeBaseRef(graph, "TAIL"), {
      name: "refs/heads/spg/node/S2/run-s2",
      commit: "2222222222222222222222222222222222222222",
      source: "series-predecessor",
      predecessorId: "FOLLOWUP"
    });
  });
});

test("series reconciliation blocks when a done child is missing its output ref", async () => {
  await withTempGraph(async (graphPath, dir) => {
    const graph = {
      graphVersion: 1,
      title: "Series Missing Output Plan",
      graph: {
        root: "ROOT",
        nodes: {
          ROOT: { title: "Root", kind: "series", status: "pending", children: ["SERIES", "DOWNSTREAM"] },
          SERIES: { title: "Series parent", kind: "series", status: "pending", children: ["S1", "S2"] },
          S1: {
            title: "First child",
            kind: "task",
            status: "done",
            outputRef: { name: "refs/heads/spg/node/S1/run-s1" }
          },
          S2: { title: "Final child", kind: "task", status: "done" },
          DOWNSTREAM: { title: "Downstream", kind: "task", status: "pending" }
        }
      }
    };
    await writeFile(graphPath, `${JSON.stringify(graph, null, 2)}\n`, "utf8");

    const result = await reconcileGraphStatus(graphPath);
    assert.deepEqual(result.changed, ["SERIES"]);

    const reconciled = await readGraph(graphPath);
    const parent = reconciled.graph.nodes.SERIES;
    assert.equal(parent.status, "blocked");
    assert.equal(parent.outputRef, undefined);
    assert.equal(parent.integrationRef.kind, "series");
    assert.equal(parent.integrationRef.status, "pending");
    assert.equal(parent.integrationRef.missingChildId, "S2");
    assert.match(parent.blockedReason, /S2/);
    assert.deepEqual(listReadyLeafNodes(reconciled).map((node) => node.id), []);
    assert.match(await readFile(join(dir, parent.report), "utf8"), /Missing child output ref: S2/);

    assert.deepEqual((await reconcileGraphStatus(graphPath)).changed, []);
  });
});

test("resetting a composition subtree clears stale isolation refs from every reset node", async () => {
  await withTempGraph(async (graphPath) => {
    const graph = {
      graphVersion: 1,
      graph: {
        root: "ROOT",
        nodes: {
          ROOT: { title: "Root", kind: "series", status: "done", children: ["SERIES"] },
          SERIES: {
            title: "Series parent",
            kind: "series",
            status: "done",
            children: ["S1", "S2"],
            completedAt: "2026-05-27T00:00:00.000Z",
            outputRef: { name: "refs/heads/spg/node/S2/run-s2", source: "series-alias" },
            integrationRef: {
              name: "refs/heads/spg/node/S2/run-s2",
              kind: "series",
              status: "clean",
              publishedOutputRef: "refs/heads/spg/node/S2/run-s2"
            }
          },
          S1: {
            title: "First child",
            kind: "task",
            status: "done",
            outputRef: { name: "refs/heads/spg/node/S1/run-s1" }
          },
          S2: {
            title: "Final child",
            kind: "task",
            status: "done",
            outputRef: { name: "refs/heads/spg/node/S2/run-s2" }
          }
        }
      }
    };
    await writeFile(graphPath, `${JSON.stringify(graph, null, 2)}\n`, "utf8");

    await resetSubtree(graphPath, { nodeId: "SERIES", reason: "retry integration" });

    const reset = await readGraph(graphPath);
    assert.equal(reset.graph.nodes.SERIES.status, "pending");
    assert.equal(reset.graph.nodes.SERIES.outputRef, undefined);
    assert.equal(reset.graph.nodes.SERIES.integrationRef, undefined);
    assert.equal(reset.graph.nodes.S1.outputRef, undefined);
    assert.equal(reset.graph.nodes.S2.outputRef, undefined);
    assert.ok(lastHistory(reset.graph.nodes.SERIES).clearedFields.includes("outputRef"));
    assert.ok(lastHistory(reset.graph.nodes.SERIES).clearedFields.includes("integrationRef"));
  });
});

test("nested parallel and series composition buffers publish refs before downstream readiness", async () => {
  await withLocalBareRemote(async ({ dir, sourcePath, remotePath }) => {
    const graphDir = join(dir, "graph");
    const graphPath = join(graphDir, "plan.graph.json");
    await mkdir(graphDir);

    const leftRef = await createSourceBranch({
      sourcePath,
      remotePath,
      branchName: "left-clean",
      files: { "left.txt": "left\n" },
      message: "left clean"
    });
    const rightRef = await createSourceBranch({
      sourcePath,
      remotePath,
      branchName: "right-clean",
      files: { "right.txt": "right\n" },
      message: "right clean"
    });
    const tailRef = await createSourceBranch({
      sourcePath,
      remotePath,
      branchName: "tail-clean",
      files: { "tail.txt": "tail\n" },
      message: "tail clean"
    });

    const graph = {
      graphVersion: 1,
      scheduler: { remote: remotePath, baseRef: "refs/heads/main" },
      graph: {
        root: "ROOT",
        nodes: {
          ROOT: { title: "Root", kind: "series", status: "pending", children: ["SERIES", "DOWNSTREAM"] },
          SERIES: { title: "Series parent", kind: "series", status: "pending", children: ["FANOUT", "TAIL"] },
          FANOUT: { title: "Fanout", kind: "parallel", status: "pending", children: ["LEFT", "RIGHT"] },
          LEFT: { title: "Left", kind: "task", status: "done", outputRef: leftRef },
          RIGHT: { title: "Right", kind: "task", status: "done", outputRef: rightRef },
          TAIL: { title: "Tail", kind: "task", status: "done", outputRef: tailRef },
          DOWNSTREAM: { title: "Downstream", kind: "task", status: "pending" }
        }
      }
    };
    await writeFile(graphPath, `${JSON.stringify(graph, null, 2)}\n`, "utf8");
    await prepareCompositionBareRepository({ graphDir, remotePath });

    assert.deepEqual(listReadyLeafNodes(graph).map((node) => node.id), []);

    const result = await reconcileGraphStatus(graphPath);
    assert.deepEqual(result.changed, ["FANOUT", "SERIES"]);

    const reconciled = await readGraph(graphPath);
    assert.equal(reconciled.graph.nodes.FANOUT.status, "done");
    assert.equal(reconciled.graph.nodes.FANOUT.integrationRef.status, "clean");
    assert.deepEqual(reconciled.graph.nodes.FANOUT.integrationRef.inputRefs.map((input) => input.nodeId), ["LEFT", "RIGHT"]);
    assert.equal(reconciled.graph.nodes.FANOUT.outputRef.diffStat, undefined);
    assert.deepEqual(reconciled.graph.nodes.FANOUT.gitFootprint.diffStat, { filesChanged: 2, additions: 2, deletions: 0, totalChanges: 2 });
    assert.equal(reconciled.graph.nodes.SERIES.status, "done");
    assert.equal(reconciled.graph.nodes.SERIES.outputRef.name, tailRef.name);
    assert.equal(reconciled.graph.nodes.SERIES.outputRef.diffStat, undefined);
    assert.deepEqual(reconciled.graph.nodes.SERIES.gitFootprint.diffStat, { filesChanged: 1, additions: 1, deletions: 0, totalChanges: 1 });
    assert.deepEqual(reconciled.graph.nodes.SERIES.integrationRef.inputRefs.map((input) => input.nodeId), ["FANOUT", "TAIL"]);
    assert.equal(reconciled.graph.nodes.SERIES.integrationRef.inputRefs[0].outputRef, reconciled.graph.nodes.FANOUT.outputRef.name);
    const fanoutPublishEvent = reconciled.graph.nodes.FANOUT.history.find((entry) => entry.event === "parent-ref-published");
    assert.equal(fanoutPublishEvent.diffStatCollected, true);
    assert.deepEqual(fanoutPublishEvent.diffStat, reconciled.graph.nodes.FANOUT.gitFootprint.diffStat);
    assert.equal("files" in fanoutPublishEvent, false);
    const seriesPublishEvent = reconciled.graph.nodes.SERIES.history.find((entry) => entry.event === "parent-ref-published");
    assert.equal(seriesPublishEvent.diffStatCollected, true);
    assert.deepEqual(seriesPublishEvent.diffStat, reconciled.graph.nodes.SERIES.gitFootprint.diffStat);
    assert.equal("files" in seriesPublishEvent, false);
    assert.deepEqual(listReadyLeafNodes(reconciled).map((node) => node.id), ["DOWNSTREAM"]);
  });
});

test("git runtime prepares a bare cache, creates a clone branch, and publishes an output ref", async () => {
  await withLocalBareRemote(async ({ dir, remotePath }) => {
    const bareRepoPath = join(dir, "cache", "repo.git");
    const cloneCwd = join(dir, "workspaces", "codex-A", "Task A", "run_20260527_000000_A_abc123");

    const prepared = await prepareBareRepository({ remote: remotePath, bareRepoPath });
    assert.equal(prepared.created, true);
    assert.equal(prepared.bareRepoPath, bareRepoPath);

    const clone = await createRunClone({ bareRepoPath, cloneCwd });
    assert.equal(clone.cloneCwd, cloneCwd);
    assert.equal(existsSync(join(cloneCwd, ".git")), true);

    const branch = await createWorkBranch({
      cloneCwd,
      nodeId: "Task A/unsafe",
      runId: "run_20260527_000000_A_abc123",
      baseRef: "HEAD",
      bareRepoPath
    });
    assert.match(branch.workRef, /^refs\/heads\/spg\/node\/Task-A-unsafe-[0-9a-f]{8}\/run_20260527_000000_A_abc123$/);

    await execFileAsync("git", ["config", "user.email", "scheduler-tests@example.test"], { cwd: cloneCwd });
    await execFileAsync("git", ["config", "user.name", "Scheduler Tests"], { cwd: cloneCwd });
    await writeFile(join(cloneCwd, "worker-output.txt"), "isolated output\n", "utf8");
    await execFileAsync("git", ["add", "worker-output.txt"], { cwd: cloneCwd });
    await execFileAsync("git", ["commit", "-m", "worker output"], { cwd: cloneCwd });

    const published = await publishOutputRef({ cloneCwd, workRef: branch.workRef });
    assert.equal(published.outputRef, branch.workRef);
    assert.match(published.commit, /^[0-9a-f]{40}$/);

    const resolved = await execFileAsync("git", ["--git-dir", bareRepoPath, "rev-parse", published.outputRef]);
    assert.equal(resolved.stdout.trim(), published.commit);
  });
});

test("git runtime creates downstream branches from published head refs after cloning", async () => {
  await withLocalBareRemote(async ({ dir, remotePath }) => {
    const bareRepoPath = join(dir, "cache", "repo.git");
    const upstreamCloneCwd = join(dir, "workspaces", "codex-A", "A", "run-upstream");
    const downstreamCloneCwd = join(dir, "workspaces", "codex-B", "B", "run-downstream");

    await prepareBareRepository({ remote: remotePath, bareRepoPath });
    await createRunClone({ bareRepoPath, cloneCwd: upstreamCloneCwd });
    const upstream = await createWorkBranch({
      cloneCwd: upstreamCloneCwd,
      nodeId: "A",
      runId: "run-upstream",
      baseRef: "HEAD",
      bareRepoPath
    });
    await execFileAsync("git", ["config", "user.email", "scheduler-tests@example.test"], { cwd: upstreamCloneCwd });
    await execFileAsync("git", ["config", "user.name", "Scheduler Tests"], { cwd: upstreamCloneCwd });
    await writeFile(join(upstreamCloneCwd, "upstream.txt"), "upstream output\n", "utf8");
    await execFileAsync("git", ["add", "upstream.txt"], { cwd: upstreamCloneCwd });
    await execFileAsync("git", ["commit", "-m", "upstream output"], { cwd: upstreamCloneCwd });
    const published = await publishOutputRef({ cloneCwd: upstreamCloneCwd, workRef: upstream.workRef });

    await createRunClone({ bareRepoPath, cloneCwd: downstreamCloneCwd });
    const downstream = await createWorkBranch({
      cloneCwd: downstreamCloneCwd,
      nodeId: "B",
      runId: "run-downstream",
      baseRef: published.outputRef,
      bareRepoPath
    });

    assert.equal(downstream.baseRef, published.outputRef);
    assert.equal(downstream.commit, published.commit);
    assert.equal(await readFile(join(downstreamCloneCwd, "upstream.txt"), "utf8"), "upstream output\n");
  });
});

test("git runtime refresh preserves local worker output refs", async () => {
  await withLocalBareRemote(async ({ dir, remotePath }) => {
    const bareRepoPath = join(dir, "cache", "repo.git");
    const cloneCwd = join(dir, "workspaces", "codex-A", "A", "run-preserve");

    await prepareBareRepository({ remote: remotePath, bareRepoPath });
    await createRunClone({ bareRepoPath, cloneCwd });
    const branch = await createWorkBranch({
      cloneCwd,
      nodeId: "A",
      runId: "run-preserve",
      baseRef: "HEAD",
      bareRepoPath
    });
    await execFileAsync("git", ["config", "user.email", "scheduler-tests@example.test"], { cwd: cloneCwd });
    await execFileAsync("git", ["config", "user.name", "Scheduler Tests"], { cwd: cloneCwd });
    await writeFile(join(cloneCwd, "worker-output.txt"), "preserve me\n", "utf8");
    await execFileAsync("git", ["add", "worker-output.txt"], { cwd: cloneCwd });
    await execFileAsync("git", ["commit", "-m", "worker output"], { cwd: cloneCwd });
    const published = await publishOutputRef({ cloneCwd, workRef: branch.workRef });

    await prepareBareRepository({ remote: remotePath, bareRepoPath });

    const resolved = await execFileAsync("git", ["--git-dir", bareRepoPath, "rev-parse", published.outputRef]);
    assert.equal(resolved.stdout.trim(), published.commit);
    assert.equal(await gitShow(bareRepoPath, published.outputRef, "worker-output.txt"), "preserve me\n");
  });
});

test("git diffstat collector reports aggregate and file-level text changes", async () => {
  await withLocalBareRemote(async ({ dir, remotePath }) => {
    const bareRepoPath = join(dir, "cache", "repo.git");
    const cloneCwd = join(dir, "workspaces", "codex-A", "A", "run-diffstat");

    await prepareBareRepository({ remote: remotePath, bareRepoPath });
    await createRunClone({ bareRepoPath, cloneCwd });
    const branch = await createWorkBranch({
      cloneCwd,
      nodeId: "A",
      runId: "run-diffstat",
      baseRef: "HEAD",
      bareRepoPath
    });
    await execFileAsync("git", ["config", "user.email", "scheduler-tests@example.test"], { cwd: cloneCwd });
    await execFileAsync("git", ["config", "user.name", "Scheduler Tests"], { cwd: cloneCwd });
    await writeFile(join(cloneCwd, "README.md"), "fixture\nupdated\n", "utf8");
    await mkdir(join(cloneCwd, "docs"), { recursive: true });
    await writeFile(join(cloneCwd, "docs", "new.md"), "one\ntwo\n", "utf8");
    await execFileAsync("git", ["add", "."], { cwd: cloneCwd });
    await execFileAsync("git", ["commit", "-m", "text changes"], { cwd: cloneCwd });

    const collected = await collectGitDiffStat({
      cloneCwd,
      baseRef: branch.commit,
      headRef: branch.workRef,
      collectedAt: "2026-05-31T00:00:00.000Z"
    });

    assert.equal(collected.ok, true);
    assert.deepEqual(collected.diffStat, { filesChanged: 2, additions: 3, deletions: 0, totalChanges: 3 });
    assert.equal(collected.footprint.baseRef.commit, branch.commit);
    assert.equal(collected.footprint.headRef.name, branch.workRef);
    assert.equal(collected.footprint.collectedAt, "2026-05-31T00:00:00.000Z");
    assert.deepEqual(
      collected.files.map((file) => [file.path, file.changeType, file.additions, file.deletions, file.totalChanges]).sort(),
      [
        ["README.md", "modified", 1, 0, 1],
        ["docs/new.md", "added", 2, 0, 2]
      ]
    );
  });
});

test("git diffstat collector handles binary files and renames from a bare repository", async () => {
  await withLocalBareRemote(async ({ dir, sourcePath, remotePath }) => {
    await writeFile(join(sourcePath, "old.txt"), "one\n", "utf8");
    await execFileAsync("git", ["add", "old.txt"], { cwd: sourcePath });
    await execFileAsync("git", ["commit", "-m", "add rename source"], { cwd: sourcePath });
    await execFileAsync("git", ["push", remotePath, "main:refs/heads/main"], { cwd: sourcePath });

    const bareRepoPath = join(dir, "cache", "repo.git");
    const cloneCwd = join(dir, "workspaces", "codex-A", "A", "run-binary-rename");
    await prepareBareRepository({ remote: remotePath, bareRepoPath });
    await createRunClone({ bareRepoPath, cloneCwd });
    const branch = await createWorkBranch({
      cloneCwd,
      nodeId: "A",
      runId: "run-binary-rename",
      baseRef: "refs/heads/main",
      bareRepoPath
    });
    await execFileAsync("git", ["config", "user.email", "scheduler-tests@example.test"], { cwd: cloneCwd });
    await execFileAsync("git", ["config", "user.name", "Scheduler Tests"], { cwd: cloneCwd });
    await execFileAsync("git", ["mv", "old.txt", "new.txt"], { cwd: cloneCwd });
    await writeFile(join(cloneCwd, "new.txt"), "one\ntwo\n", "utf8");
    await writeFile(join(cloneCwd, "image.bin"), Buffer.from([0, 1, 2, 3]));
    await execFileAsync("git", ["add", "."], { cwd: cloneCwd });
    await execFileAsync("git", ["commit", "-m", "rename and binary"], { cwd: cloneCwd });
    const published = await publishOutputRef({ cloneCwd, workRef: branch.workRef });

    const collected = await collectGitDiffStat({
      bareRepoPath,
      baseRef: "refs/heads/main",
      headRef: published.outputRef
    });

    assert.equal(collected.ok, true);
    assert.deepEqual(collected.diffStat, { filesChanged: 2, additions: 1, deletions: 0, totalChanges: 1, binaryFiles: 1 });
    const byPath = new Map(collected.files.map((file) => [file.path, file]));
    assert.deepEqual(byPath.get("new.txt"), {
      path: "new.txt",
      oldPath: "old.txt",
      changeType: "renamed",
      additions: 1,
      deletions: 0,
      totalChanges: 1
    });
    assert.deepEqual(byPath.get("image.bin"), {
      path: "image.bin",
      changeType: "added",
      additions: null,
      deletions: null,
      totalChanges: null,
      binary: true
    });
  });
});

test("git diffstat collector returns a warning for missing refs", async () => {
  await withLocalBareRemote(async ({ dir, remotePath }) => {
    const bareRepoPath = join(dir, "cache", "repo.git");
    await prepareBareRepository({ remote: remotePath, bareRepoPath });

    const collected = await collectGitDiffStat({
      bareRepoPath,
      baseRef: "refs/heads/missing-base",
      headRef: "refs/heads/main"
    });

    assert.equal(collected.ok, false);
    assert.match(collected.warning, /missing base ref refs\/heads\/missing-base/);
  });
});

test("completeNode backfills git footprint metadata from output refs", async () => {
  await withLocalBareRemote(async ({ dir, sourcePath, remotePath }) => {
    const graphDir = join(dir, "graph");
    const graphPath = join(graphDir, "plan.graph.json");
    const credentialRemote = "https://user:secret-token@example.com/org/repo.git";
    await mkdir(graphDir);
    const outputRef = await createSourceBranch({
      sourcePath,
      remotePath,
      branchName: "direct-complete",
      files: { "direct.txt": "done\n" },
      message: "direct complete"
    });
    const bareRepoPath = await prepareCompositionBareRepository({ graphDir, remotePath });
    const graph = {
      graphVersion: 1,
      scheduler: { remote: remotePath, baseRef: "refs/heads/main" },
      graph: {
        root: "A",
        nodes: {
          A: {
            title: "Direct complete",
            kind: "task",
            status: "running",
            vendorMetadata: { preserved: true },
            lease: {
              session: "codex-A",
              runId: "run-direct",
              claimedAt: "2026-05-31T00:00:00.000Z",
              expiresAt: "2999-01-01T00:00:00.000Z"
            },
            baseRef: { name: "refs/heads/main" }
          }
        }
      }
    };
    await writeFile(graphPath, `${JSON.stringify(graph, null, 2)}\n`, "utf8");

    await completeNode(graphPath, {
      nodeId: "A",
      session: "codex-A",
      runId: "run-direct",
      report: "reports/A.md",
      refMetadata: {
        remote: credentialRemote,
        bareRepo: bareRepoPath,
        cloneCwd: sourcePath,
        outputRef,
        gitFootprintWarning: "stale preflight warning"
      }
    });

    const completed = await readGraph(graphPath);
    const node = completed.graph.nodes.A;
    assert.equal(node.status, "done");
    assert.deepEqual(node.vendorMetadata, { preserved: true });
    assert.equal(node.outputRef.name, outputRef.name);
    assert.equal(node.outputRef.diffStat, undefined);
    assert.equal(node.outputRef.files, undefined);
    assert.deepEqual(node.gitFootprint.diffStat, { filesChanged: 1, additions: 1, deletions: 0, totalChanges: 1 });
    assert.deepEqual(node.gitFootprint.files, [
      { path: "direct.txt", changeType: "added", additions: 1, deletions: 0, totalChanges: 1 }
    ]);
    assert.equal(node.gitFootprintWarning, undefined);
    assert.equal(node.gitFootprint.headRef.name, outputRef.name);
    assert.equal(node.workspace.remote, "https://[REDACTED]@example.com/org/repo.git");
    assert.doesNotMatch(JSON.stringify(node), /secret-token/);
    const cloneEvent = node.history.find((entry) => entry.event === "clone-prepared");
    assert.equal(cloneEvent.remote, "https://[REDACTED]@example.com/org/repo.git");
    const exportedCloneEvent = exportOperationalEvents(completed, { nodeId: "A", event: "clone-prepared", limit: 1 })[0];
    assert.equal(exportedCloneEvent.details.remote, "https://[REDACTED]@example.com/org/repo.git");
    assert.doesNotMatch(JSON.stringify(exportedCloneEvent), /secret-token/);
    const doneEvent = lastHistory(node);
    assert.equal(doneEvent.event, "done");
    assert.equal(doneEvent.diffStatCollected, true);
    assert.deepEqual(doneEvent.diffStat, node.gitFootprint.diffStat);
    assert.equal(doneEvent.gitFootprintWarning, undefined);
    assert.equal("files" in doneEvent, false);
  });
});

test("completeNode stores binary-file git footprint metadata from output refs", async () => {
  await withLocalBareRemote(async ({ dir, sourcePath, remotePath }) => {
    const graphDir = join(dir, "graph");
    const graphPath = join(graphDir, "plan.graph.json");
    await mkdir(graphDir);
    const outputRef = await createFixtureBranch({
      sourcePath,
      remotePath,
      branchName: "binary-output",
      binaryFiles: { "assets/logo.bin": Buffer.from([0, 1, 2, 3, 4]) },
      message: "binary output"
    });
    const bareRepoPath = await prepareCompositionBareRepository({ graphDir, remotePath });
    await writeFile(graphPath, `${JSON.stringify({
      graphVersion: 1,
      scheduler: { remote: remotePath, baseRef: "refs/heads/main" },
      graph: {
        root: "A",
        nodes: {
          A: {
            title: "Binary complete",
            kind: "task",
            status: "running",
            lease: {
              session: "codex-A",
              runId: "run-binary",
              claimedAt: "2026-05-31T00:00:00.000Z",
              expiresAt: "2999-01-01T00:00:00.000Z"
            }
          }
        }
      }
    }, null, 2)}\n`, "utf8");

    await completeNode(graphPath, {
      nodeId: "A",
      session: "codex-A",
      runId: "run-binary",
      refMetadata: {
        bareRepo: bareRepoPath,
        outputRef
      }
    });

    const graph = await readGraph(graphPath);
    const node = graph.graph.nodes.A;
    assert.equal(node.status, "done");
    assert.equal(node.outputRef.diffStat, undefined);
    assert.equal(node.outputRef.files, undefined);
    assert.deepEqual(node.gitFootprint.diffStat, { filesChanged: 1, additions: 0, deletions: 0, totalChanges: 0, binaryFiles: 1 });
    assert.deepEqual(node.gitFootprint.files, [
      {
        path: "assets/logo.bin",
        changeType: "added",
        additions: null,
        deletions: null,
        totalChanges: null,
        binary: true
      }
    ]);
    assert.equal(lastHistory(node).diffStatCollected, true);
  });
});

test("series completion aggregates child git footprints from local output refs", async () => {
  await withLocalBareRemote(async ({ dir, sourcePath, remotePath }) => {
    const graphDir = join(dir, "graph");
    const graphPath = join(graphDir, "plan.graph.json");
    await mkdir(graphDir);
    const firstOutput = await createFixtureBranch({
      sourcePath,
      remotePath,
      branchName: "spg/node/S1/run-series-one",
      textFiles: { "series-one.txt": "one\n" },
      message: "series one"
    });
    const secondOutput = await createFixtureBranch({
      sourcePath,
      remotePath,
      branchName: "spg/node/S2/run-series-two",
      baseRef: firstOutput.name,
      textFiles: { "series-two.txt": "two\nthree\n" },
      message: "series two"
    });
    const bareRepoPath = await prepareCompositionBareRepository({ graphDir, remotePath });
    await writeFile(graphPath, `${JSON.stringify({
      graphVersion: 1,
      scheduler: { remote: remotePath, baseRef: "refs/heads/main" },
      graph: {
        root: "SERIES",
        nodes: {
          SERIES: { title: "Series parent", kind: "series", status: "pending", children: ["S1", "S2"] },
          S1: {
            title: "Series child one",
            kind: "task",
            status: "running",
            lease: { session: "codex-S1", runId: "run-s1", claimedAt: "2026-05-31T00:00:00.000Z", expiresAt: "2999-01-01T00:00:00.000Z" }
          },
          S2: {
            title: "Series child two",
            kind: "task",
            status: "running",
            lease: { session: "codex-S2", runId: "run-s2", claimedAt: "2026-05-31T00:00:00.000Z", expiresAt: "2999-01-01T00:00:00.000Z" }
          }
        }
      }
    }, null, 2)}\n`, "utf8");

    await completeNode(graphPath, {
      nodeId: "S1",
      session: "codex-S1",
      runId: "run-s1",
      refMetadata: { bareRepo: bareRepoPath, outputRef: firstOutput }
    });
    await completeNode(graphPath, {
      nodeId: "S2",
      session: "codex-S2",
      runId: "run-s2",
      refMetadata: { bareRepo: bareRepoPath, outputRef: secondOutput }
    });

    const graph = await readGraph(graphPath);
    const parent = graph.graph.nodes.SERIES;
    assert.equal(parent.status, "done");
    assert.equal(parent.outputRef.name, secondOutput.name);
    assert.equal(parent.gitFootprint.source, "git-diff");
    assert.deepEqual(parent.gitFootprint.diffStat, { filesChanged: 2, additions: 3, deletions: 0, totalChanges: 3 });
    assert.deepEqual(parent.gitFootprint.files.map((file) => [file.path, file.additions]), [
      ["series-one.txt", 1],
      ["series-two.txt", 2]
    ]);
    assert.deepEqual(parent.gitFootprint.childAggregate.diffStat, { filesChanged: 2, additions: 3, deletions: 0, totalChanges: 3 });
    assert.deepEqual(parent.gitFootprint.childAggregate.aggregation.includedChildIds, ["S1", "S2"]);
    assert.deepEqual(parent.integrationRef.inputRefs.map((input) => input.outputRef), [firstOutput.name, secondOutput.name]);
    const publishEvent = parent.history.find((entry) => entry.event === "parent-ref-published");
    assert.equal(publishEvent.diffStatCollected, true);
    assert.deepEqual(publishEvent.diffStat, parent.gitFootprint.diffStat);
  });
});

test("parallel completion aggregates child git footprints from local output refs", async () => {
  await withLocalBareRemote(async ({ dir, sourcePath, remotePath }) => {
    const graphDir = join(dir, "graph");
    const graphPath = join(graphDir, "plan.graph.json");
    await mkdir(graphDir);
    const leftOutput = await createFixtureBranch({
      sourcePath,
      remotePath,
      branchName: "spg/node/A/run-parallel-left",
      textFiles: { "parallel-left.txt": "left\n" },
      message: "parallel left"
    });
    const rightOutput = await createFixtureBranch({
      sourcePath,
      remotePath,
      branchName: "spg/node/B/run-parallel-right",
      textFiles: { "parallel-right.txt": "right\nagain\n" },
      message: "parallel right"
    });
    const bareRepoPath = await prepareCompositionBareRepository({ graphDir, remotePath });
    await writeFile(graphPath, `${JSON.stringify({
      graphVersion: 1,
      scheduler: { remote: remotePath, baseRef: "refs/heads/main" },
      graph: {
        root: "P",
        nodes: {
          P: { title: "Parallel parent", kind: "parallel", status: "pending", children: ["A", "B"] },
          A: {
            title: "Branch A",
            kind: "task",
            status: "running",
            lease: { session: "codex-A", runId: "run-a", claimedAt: "2026-05-31T00:00:00.000Z", expiresAt: "2999-01-01T00:00:00.000Z" }
          },
          B: {
            title: "Branch B",
            kind: "task",
            status: "running",
            lease: { session: "codex-B", runId: "run-b", claimedAt: "2026-05-31T00:00:00.000Z", expiresAt: "2999-01-01T00:00:00.000Z" }
          }
        }
      }
    }, null, 2)}\n`, "utf8");

    await completeNode(graphPath, {
      nodeId: "A",
      session: "codex-A",
      runId: "run-a",
      refMetadata: { bareRepo: bareRepoPath, outputRef: leftOutput }
    });
    await completeNode(graphPath, {
      nodeId: "B",
      session: "codex-B",
      runId: "run-b",
      refMetadata: { bareRepo: bareRepoPath, outputRef: rightOutput }
    });

    const graph = await readGraph(graphPath);
    const parent = graph.graph.nodes.P;
    assert.equal(parent.status, "done");
    assert.equal(parent.outputRef.source, "parallel-integration");
    assert.equal(parent.outputRef.name, parent.integrationRef.publishedOutputRef);
    assert.deepEqual(parent.gitFootprint.diffStat, { filesChanged: 2, additions: 3, deletions: 0, totalChanges: 3 });
    assert.deepEqual(parent.gitFootprint.files.map((file) => [file.path, file.additions]), [
      ["parallel-left.txt", 1],
      ["parallel-right.txt", 2]
    ]);
    assert.deepEqual(parent.gitFootprint.childAggregate.diffStat, parent.gitFootprint.diffStat);
    assert.deepEqual(parent.gitFootprint.childAggregate.aggregation.includedChildIds, ["A", "B"]);
    assert.deepEqual(parent.integrationRef.inputRefs.map((input) => input.outputRef), [leftOutput.name, rightOutput.name]);
    assert.equal(await gitShow(bareRepoPath, parent.outputRef.name, "parallel-left.txt"), "left\n");
    assert.equal(await gitShow(bareRepoPath, parent.outputRef.name, "parallel-right.txt"), "right\nagain\n");
  });
});

test("completeNode keeps successful completion when git footprint collection fails", async () => {
  await withLocalBareRemote(async ({ dir, remotePath }) => {
    const graphDir = join(dir, "graph");
    const graphPath = join(graphDir, "plan.graph.json");
    await mkdir(graphDir);
    const bareRepoPath = await prepareCompositionBareRepository({ graphDir, remotePath });
    const graph = {
      graphVersion: 1,
      scheduler: { remote: remotePath, baseRef: "refs/heads/main" },
      graph: {
        root: "A",
        nodes: {
          A: {
            title: "Direct complete without stats",
            kind: "task",
            status: "running",
            lease: {
              session: "codex-A",
              runId: "run-direct-warning",
              claimedAt: "2026-05-31T00:00:00.000Z",
              expiresAt: "2999-01-01T00:00:00.000Z"
            },
            baseRef: { name: "refs/heads/main" }
          }
        }
      }
    };
    await writeFile(graphPath, `${JSON.stringify(graph, null, 2)}\n`, "utf8");

    await completeNode(graphPath, {
      nodeId: "A",
      session: "codex-A",
      runId: "run-direct-warning",
      refMetadata: {
        bareRepo: bareRepoPath,
        outputRef: {
          name: "refs/heads/missing-output"
        }
      }
    });

    const completed = await readGraph(graphPath);
    const node = completed.graph.nodes.A;
    assert.equal(node.status, "done");
    assert.equal(node.outputRef.name, "refs/heads/missing-output");
    assert.equal(node.outputRef.diffStat, undefined);
    assert.match(node.gitFootprintWarning, /Git diffstat omitted: missing head ref refs\/heads\/missing-output/);
    const doneEvent = lastHistory(node);
    assert.equal(doneEvent.diffStatCollected, false);
    assert.match(doneEvent.gitFootprintWarning, /Git diffstat omitted: missing head ref refs\/heads\/missing-output/);
    assert.equal("files" in doneEvent, false);
  });
});

test("completeNode records a warning when git diffstat cannot start git", async () => {
  await withLocalBareRemote(async ({ dir, sourcePath, remotePath }) => {
    const graphDir = join(dir, "graph");
    const graphPath = join(graphDir, "plan.graph.json");
    const emptyBin = join(dir, "empty-bin");
    await mkdir(graphDir);
    await mkdir(emptyBin);
    const outputRef = await createSourceBranch({
      sourcePath,
      remotePath,
      branchName: "direct-complete-missing-git",
      files: { "direct.txt": "done\n" },
      message: "direct complete missing git"
    });
    const bareRepoPath = await prepareCompositionBareRepository({ graphDir, remotePath });
    await writeFile(graphPath, `${JSON.stringify({
      graphVersion: 1,
      scheduler: { remote: remotePath, baseRef: "refs/heads/main" },
      graph: {
        root: "A",
        nodes: {
          A: {
            title: "Direct complete with missing git",
            kind: "task",
            status: "running",
            lease: { session: "codex-A", runId: "run-missing-git", claimedAt: "2026-05-31T00:00:00.000Z", expiresAt: "2999-01-01T00:00:00.000Z" },
            baseRef: { name: "refs/heads/main" }
          }
        }
      }
    }, null, 2)}\n`, "utf8");

    const originalPath = process.env.PATH;
    process.env.PATH = emptyBin;
    try {
      await completeNode(graphPath, {
        nodeId: "A",
        session: "codex-A",
        runId: "run-missing-git",
        refMetadata: { bareRepo: bareRepoPath, outputRef }
      });
    } finally {
      process.env.PATH = originalPath;
    }

    const completed = await readGraph(graphPath);
    const node = completed.graph.nodes.A;
    assert.equal(node.status, "done");
    assert.equal(node.outputRef.name, outputRef.name);
    assert.equal(node.outputRef.diffStat, undefined);
    assert.match(node.gitFootprintWarning, /Git diffstat collection failed: .*command could not be started/);
    assert.equal(lastHistory(node).diffStatCollected, false);
  });
});

test("git runtime reports missing remote before running Git", async () => {
  const commands = [];
  await assert.rejects(
    prepareBareRepository({
      remote: "",
      bareRepoPath: "/tmp/unused.git",
      git: async (command) => {
        commands.push(command);
        return { stdout: "", stderr: "", exitCode: 0 };
      }
    }),
    /Worker isolation requires scheduler\.remote/
  );
  assert.deepEqual(commands, []);
});

test("git runtime cache lock timeout includes owner diagnostics", async () => {
  const dir = await mkdtemp(join(tmpdir(), "git-runtime-lock-"));
  try {
    const bareRepoPath = join(dir, "cache", "repo.git");
    const lockPath = join(dir, "cache", ".repo.git.lock");
    await mkdir(lockPath, { recursive: true });
    await writeFile(join(lockPath, "owner.json"), `${JSON.stringify({
      pid: 12345,
      createdAt: "2026-05-30T00:00:00.000Z",
      lockPath
    }, null, 2)}\n`, "utf8");

    await assert.rejects(
      prepareBareRepository({
        remote: "https://example.com/org/repo.git",
        bareRepoPath,
        lockTimeoutMs: 5,
        lockStaleMs: 60_000,
        git: async () => {
          throw new Error("git should not run before lock acquisition");
        }
      }),
      (error) => {
        assert.match(error.message, /Timed out waiting for Git cache lock:/);
        assert.match(error.message, /pid=12345/);
        assert.match(error.message, /createdAt=2026-05-30T00:00:00\.000Z/);
        assert.match(error.message, /owner\.json/);
        assert.match(error.message, /timeoutMs=5/);
        return true;
      }
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("git runtime captures fetch failures with redacted bounded output", async () => {
  const secretDir = await mkdtemp(join(tmpdir(), "git-runtime-token=super-secret-"));
  try {
    const sourcePath = join(secretDir, "source");
    const remotePath = join(secretDir, "remote.git");
    const bareRepoPath = join(secretDir, "cache", "repo.git");
    await mkdir(sourcePath);
    await execFileAsync("git", ["init"], { cwd: sourcePath });
    await execFileAsync("git", ["checkout", "-B", "main"], { cwd: sourcePath });
    await execFileAsync("git", ["config", "user.email", "scheduler-tests@example.test"], { cwd: sourcePath });
    await execFileAsync("git", ["config", "user.name", "Scheduler Tests"], { cwd: sourcePath });
    await writeFile(join(sourcePath, "README.md"), "fixture\n", "utf8");
    await execFileAsync("git", ["add", "README.md"], { cwd: sourcePath });
    await execFileAsync("git", ["commit", "-m", "initial fixture"], { cwd: sourcePath });
    await execFileAsync("git", ["clone", "--bare", sourcePath, remotePath]);
    await prepareBareRepository({ remote: remotePath, bareRepoPath });

    await rm(remotePath, { recursive: true, force: true });
    await assert.rejects(
      prepareBareRepository({ remote: remotePath, bareRepoPath }),
      (error) => {
        assert.match(error.message, /Worker isolation remote fetch failed/);
        assert.match(error.message, /fatal|does not appear to be a git repository|Could not read/);
        assert.doesNotMatch(error.message, /super-secret/);
        assert.ok(error.summary.length <= 1203);
        return true;
      }
    );
  } finally {
    await rm(secretDir, { recursive: true, force: true });
  }
});

test("git runtime refuses clone workspace collisions", async () => {
  await withLocalBareRemote(async ({ dir, remotePath }) => {
    const bareRepoPath = join(dir, "cache", "repo.git");
    const cloneCwd = join(dir, "workspaces", "codex-A", "A", "run-collision");
    await prepareBareRepository({ remote: remotePath, bareRepoPath });
    await mkdir(cloneCwd, { recursive: true });

    await assert.rejects(
      createRunClone({ bareRepoPath, cloneCwd }),
      /Worker isolation clone failed .*workspace collision/
    );
  });
});

test("git runtime branch names are deterministic and Git-safe", () => {
  assert.equal(
    buildNodeWorkBranchName("A", "run_20260527_000000_A_abc123"),
    "spg/node/A/run_20260527_000000_A_abc123"
  );
  assert.match(
    buildNodeWorkBranchName("Task A/unsafe..name", "run with spaces"),
    /^spg\/node\/Task-A-unsafe.name-[0-9a-f]{8}\/run-with-spaces-[0-9a-f]{8}$/
  );
});

test("git runtime invokes commands as argument arrays without shell interpolation", async () => {
  const commands = [];
  const remote = "https://user:token@example.com/org/repo.git; touch SHOULD_NOT_RUN";
  const dir = await mkdtemp(join(tmpdir(), "git-runtime-argv-"));
  try {
    const bareRepoPath = join(dir, "cache", "repo.git");
    const cloneCwd = join(dir, "workspace");
    const suspiciousBarePath = join(dir, "cache", "repo.git; touch SHOULD_NOT_RUN");
    const fakeGit = async (command) => {
      commands.push(command);
      if (command.args.includes("rev-parse")) {
        return { stdout: "0123456789012345678901234567890123456789\n", stderr: "", exitCode: 0 };
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    };

    await prepareBareRepository({ remote, bareRepoPath, git: fakeGit });
    await createRunClone({ bareRepoPath: suspiciousBarePath, cloneCwd, git: fakeGit });
    await publishOutputRef({
      cloneCwd,
      workRef: "refs/heads/spg/node/A/run_1",
      outputRef: "refs/heads/spg/node/A/run_1",
      git: fakeGit
    });

    assert.deepEqual(commands[0].args.slice(0, 3), ["clone", "--bare", remote]);
    assert.equal(commands[0].args.length, 4);
    assert.match(commands[0].args[3], new RegExp(`${bareRepoPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}|\\.tmp$`));
    assert.deepEqual(commands[1].args, ["clone", suspiciousBarePath, cloneCwd]);
    assert.deepEqual(commands.at(-1).args, [
      "-C",
      cloneCwd,
      "push",
      "origin",
      "refs/heads/spg/node/A/run_1:refs/heads/spg/node/A/run_1"
    ]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runGitCommand summarizes Git stderr safely", async () => {
  await assert.rejects(
    runGitCommand({
      args: ["--git-dir", "/definitely/missing.git", "rev-parse", "--is-bare-repository"],
      failurePrefix: "Worker isolation bare repository invalid for /definitely/missing.git:"
    }),
    (error) => {
      assert.match(error.message, /Worker isolation bare repository invalid/);
      assert.match(error.message, /fatal|not a git repository/);
      assert.doesNotMatch(error.message, /\n/);
      return true;
    }
  );
});

test("leased worker-owned mutations require ownership while unleased legacy nodes remain supported", async (t) => {
  const workerOwnedCases = [
    {
      command: "start",
      runUnleased: (graphPath) => startNode(graphPath, { nodeId: "A" }),
      runWithoutOwner: (graphPath) => startNode(graphPath, { nodeId: "A" })
    },
    {
      command: "done",
      runUnleased: (graphPath) => completeNode(graphPath, { nodeId: "A" }),
      runWithoutOwner: (graphPath) => completeNode(graphPath, { nodeId: "A" })
    },
    {
      command: "block",
      runUnleased: (graphPath) => blockNode(graphPath, { nodeId: "A" }),
      runWithoutOwner: (graphPath) => blockNode(graphPath, { nodeId: "A" })
    },
    {
      command: "fail",
      runUnleased: (graphPath) => failNode(graphPath, { nodeId: "A" }),
      runWithoutOwner: (graphPath) => failNode(graphPath, { nodeId: "A" })
    },
    {
      command: "decompose",
      runUnleased: (graphPath) => decomposeNode(graphPath, {
        nodeId: "A",
        kind: "series",
        children: [{ id: "A1", title: "Child" }]
      }),
      runWithoutOwner: (graphPath) => decomposeNode(graphPath, {
        nodeId: "A",
        kind: "series",
        children: [{ id: "A1", title: "Child" }]
      })
    }
  ];

  for (const item of workerOwnedCases) {
    for (const status of schedulerTransitionTable[item.command].allowedFrom) {
      await t.test(`${item.command} accepts legacy unleased ${status}`, async () => {
        await withTempGraph(async (graphPath) => {
          await setNodeStatus(graphPath, "A", status, { lease: false });
          await item.runUnleased(graphPath);
        });
      });

      await t.test(`${item.command} rejects leased ${status} without owner`, async () => {
        await withTempGraph(async (graphPath) => {
          await setNodeStatus(graphPath, "A", status, { lease: true });
          await assert.rejects(
            item.runWithoutOwner(graphPath),
            /session or runId is required/
          );
        });
      });
    }
  }

  for (const status of knownTransitionStatuses) {
    await t.test(`renew rejects unleased ${status}`, async () => {
      await withTempGraph(async (graphPath) => {
        await setNodeStatus(graphPath, "A", status, { lease: false });
        await assert.rejects(
          renewNodeLease(graphPath, { nodeId: "A", session: "owner" }),
          /Cannot renew node without a lease/
        );
      });
    });
  }
});

test("managed isolated workers pass worker flags as spawn arguments", async () => {
  await withTempGraph(async (graphPath, dir) => {
    const fakeSchedulerPath = join(dir, "fake-scheduler.mjs");
    const capturedArgsPath = join(dir, "captured-worker-args.json");
    await writeFile(
      fakeSchedulerPath,
      [
        "import { writeFileSync } from 'node:fs';",
        `writeFileSync(${JSON.stringify(capturedArgsPath)}, JSON.stringify(process.argv.slice(2)));`,
        "console.log(JSON.stringify(process.argv.slice(2)));"
      ].join("\n"),
      "utf8"
    );
    const manager = createRawWorkerManager({
      graphPath,
      defaultCwd: dir,
      schedulerScriptPath: fakeSchedulerPath,
      rootDir: dir
    });
    const remote = "https://user:token@example.com/org/repo.git; touch SHOULD_NOT_RUN";
    manager.startWorkers({
      count: 1,
      sessionPrefix: "iso",
      isolation: "git",
      remote,
      workspaceRoot: "runs/workspaces",
      workspaceRetention: "always",
      codexCommand: process.execPath,
      codexArgs: ["exec"]
    });

    const status = await waitFor(() => {
      const snapshot = manager.status();
      return snapshot.workers[0]?.status === "exited" ? snapshot : undefined;
    });
    assert.equal(status.workers[0].isolation, "git");
    assert.equal(status.workers[0].remote, "https://[REDACTED]@example.com/org/repo.git; touch SHOULD_NOT_RUN");
    assert.equal(status.workers[0].workspaceRoot, join(dir, "runs/workspaces"));
    assert.equal(status.workers[0].workspaceRetention, "always");
    const stdout = status.workers[0].logTail.find((entry) => entry.stream === "stdout")?.text || "";
    assert.match(stdout, /https:\/\/\[REDACTED\]@example\.com\/org\/repo\.git; touch SHOULD_NOT_RUN/);
    assert.doesNotMatch(stdout, /user:token/);
    const args = JSON.parse(await readFile(capturedArgsPath, "utf8"));
    assert.deepEqual(args.slice(0, 7), [
      "worker",
      "--graph",
      graphPath,
      "--session",
      "iso-01",
      "--isolation",
      "git"
    ]);
    assert.equal(args[args.indexOf("--remote") + 1], remote);
    assert.equal(args[args.indexOf("--workspace-root") + 1], join(dir, "runs/workspaces"));
    assert.equal(args[args.indexOf("--workspace-retention") + 1], "always");
    assert.equal(args.includes("--cwd"), false);
  });
});

test("worker manager keeps bounded structured log entries", async () => {
  await withTempGraph(async (graphPath, dir) => {
    const fakeSchedulerPath = join(dir, "fake-scheduler.mjs");
    await writeFile(
      fakeSchedulerPath,
      `
for (let index = 0; index < 30; index += 1) {
  process.stdout.write("entry-" + index + "-" + "x".repeat(1100) + "-tail-" + index + "\\n");
  await new Promise((resolve) => setTimeout(resolve, 2));
}
`,
      "utf8"
    );
    const manager = createRawWorkerManager({
      graphPath,
      defaultCwd: dir,
      schedulerScriptPath: fakeSchedulerPath,
      rootDir: dir
    });

    manager.startWorkers({ count: 1, sessionPrefix: "logs" });
    const status = await waitFor(() => {
      const snapshot = manager.status();
      return snapshot.workers[0]?.status === "exited" ? snapshot : undefined;
    });
    const worker = status.workers[0];

    assert.equal(status.exited, 1);
    assert.equal(status.error, 0);
    assert.ok(worker.logTail.length <= 25);
    assert.ok(worker.durationMs >= 0);
    assert.ok(worker.logTail.every((entry) => entry.at && typeof entry.stream === "string"));
    assert.ok(worker.logTail.every((entry) => entry.text.length <= 1000));
    const stdoutEntries = worker.logTail.filter((entry) => entry.stream === "stdout");
    assert.ok(stdoutEntries.length > 0);
    assert.ok(stdoutEntries.every((entry) => entry.truncated === true));
    assert.ok(stdoutEntries.every((entry) => entry.originalLength > entry.text.length));
    assert.ok(stdoutEntries.every((entry) => entry.originalBytes >= entry.originalLength));
    assert.ok(stdoutEntries.some((entry) => entry.text.includes("-tail-29")));
    assert.ok(!stdoutEntries.some((entry) => entry.text.includes("-tail-0\n")));
  });
});

test("worker manager distinguishes idle exits from failed workers", async () => {
  await withTempGraph(async (graphPath, dir) => {
    const successSchedulerPath = join(dir, "success-scheduler.mjs");
    const failingSchedulerPath = join(dir, "failing-scheduler.mjs");
    await writeFile(successSchedulerPath, "process.stdout.write('idle exit\\n');\n", "utf8");
    await writeFile(failingSchedulerPath, "process.stderr.write('failed worker\\n'); process.exit(7);\n", "utf8");

    const successManager = createRawWorkerManager({
      graphPath,
      defaultCwd: dir,
      schedulerScriptPath: successSchedulerPath,
      rootDir: dir
    });
    successManager.startWorkers({ count: 1, sessionPrefix: "idle" });
    const idleStatus = await waitFor(() => {
      const snapshot = successManager.status();
      return snapshot.workers[0]?.status === "exited" ? snapshot : undefined;
    });
    assert.equal(idleStatus.exited, 1);
    assert.equal(idleStatus.error, 0);
    assert.equal(idleStatus.workers[0].recentFailureReason, undefined);

    const failingManager = createRawWorkerManager({
      graphPath,
      defaultCwd: dir,
      schedulerScriptPath: failingSchedulerPath,
      rootDir: dir
    });
    failingManager.startWorkers({ count: 1, sessionPrefix: "fail" });
    const failureStatus = await waitFor(() => {
      const snapshot = failingManager.status();
      return snapshot.workers[0]?.status === "error" ? snapshot : undefined;
    });
    assert.equal(failureStatus.exited, 0);
    assert.equal(failureStatus.error, 1);
    assert.equal(failureStatus.recentFailureReason, "Exited with code 7");
    assert.equal(failureStatus.workers[0].recentFailureReason, "Exited with code 7");
    assert.match(failureStatus.workers[0].error, /Exited with code 7/);
    assert.ok(failureStatus.workers[0].durationMs >= 0);
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

test("worker prompt templates render every supported variable and preserve unknown placeholders", async () => {
  await withTempGraph(async (graphPath, dir) => {
    const templatePath = join(dir, "all-vars-template.md");
    await writeFile(
      templatePath,
      [
        "cwd={{cwd}}",
        "graphPath={{graphPath}}",
        "nodeId={{nodeId}}",
        "runId={{runId}}",
        "session={{session}}",
        "reportPath={{reportPath}}",
        "schedulerCommand={{schedulerCommand}}",
        "planTitle={{planTitle}}",
        "planDescription={{planDescription}}",
        "nodeTitle={{nodeTitle}}",
        "nodeKind={{nodeKind}}",
        "nodeStatus={{nodeStatus}}",
        "unknown={{missingPromptVariable}}",
        "nodeJson:",
        "{{nodeJson}}",
        "readyJson:",
        "{{readyJson}}",
        "summaryJson:",
        "{{summaryJson}}"
      ].join("\n"),
      "utf8"
    );

    const prompt = await buildWorkerPrompt(graphPath, {
      nodeId: "A",
      session: "codex-A",
      runId: "run-test",
      templatePath,
      cwd: dir,
      reportPath: "reports/A.md"
    });

    assert.match(prompt, new RegExp(`cwd=${dir.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    assert.match(prompt, new RegExp(`graphPath=${graphPath.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    assert.match(prompt, /nodeId=A/);
    assert.match(prompt, /runId=run-test/);
    assert.match(prompt, /session=codex-A/);
    assert.match(prompt, /reportPath=reports\/A\.md/);
    assert.match(prompt, /schedulerCommand=node .+plan-scheduler\.js/);
    assert.match(prompt, /planTitle=Fixture Implementation Plan/);
    assert.match(prompt, /planDescription=Coordinate fixture work across a series root, parallel branches, and a final gate\./);
    assert.match(prompt, /nodeTitle=Bootstrap/);
    assert.match(prompt, /nodeKind=task/);
    assert.match(prompt, /nodeStatus=pending/);
    assert.match(prompt, /unknown=\{\{missingPromptVariable\}\}/);
    assert.match(prompt, /nodeJson:\n\{\n {2}"title": "Bootstrap",/);
    assert.match(prompt, /readyJson:\n\[\n {2}\{\n {4}"id": "A",/);
    assert.match(prompt, /"depth": 1/);
    assert.match(prompt, /"child_count": 0/);
    assert.match(prompt, /"shared_parent_count_with_current_task": 0/);
    assert.match(prompt, /summaryJson:\n\{\n {2}"graphVersion": 1,/);
    assert.match(prompt, /"totalNodes": 6/);
  });

  await withTempGraph(async (graphPath, dir) => {
    await writeFile(graphPath, `${JSON.stringify(depthPriorityGraph(), null, 2)}\n`, "utf8");
    const templatePath = join(dir, "ready-json-template.md");
    await writeFile(templatePath, "{{readyJson}}", "utf8");

    const prompt = await buildWorkerPrompt(graphPath, {
      nodeId: "A_DEEP",
      session: "codex-A",
      runId: "run-test",
      templatePath,
      cwd: dir
    });
    const ready = JSON.parse(prompt);

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
  });
});

test("isolated worker validates missing and placeholder remotes before claim", async () => {
  await withTempGraph(async (graphPath) => {
    await assert.rejects(
      runWorker(graphPath, {
        session: "codex-isolated-missing",
        isolation: "git",
        once: true,
        stream: false,
        codexCommand: process.execPath,
        codexArgs: ["-e", "console.log('should not claim')"]
      }),
      /Worker isolation requires scheduler\.remote/
    );

    const graph = await readGraph(graphPath);
    assert.equal(graph.graph.nodes.A.status, "pending");
    assert.equal(graph.graph.nodes.A.lease, undefined);
    assert.equal(graph.graph.nodes.A.history, undefined);
  });

  await withTempGraph(async (graphPath) => {
    const graph = await readGraph(graphPath);
    graph.scheduler.remote = "TBD";
    await writeFile(graphPath, `${JSON.stringify(graph, null, 2)}\n`, "utf8");

    await assert.rejects(
      runWorker(graphPath, {
        session: "codex-isolated-placeholder",
        isolation: "git",
        once: true,
        stream: false,
        codexCommand: process.execPath,
        codexArgs: ["-e", "console.log('should not claim')"]
      }),
      /Worker isolation remote is a placeholder and cannot be used: TBD/
    );

    const unchanged = await readGraph(graphPath);
    assert.equal(unchanged.graph.nodes.A.status, "pending");
    assert.equal(unchanged.graph.nodes.A.lease, undefined);
  });

  await withTempGraph(async (graphPath) => {
    await assertCliFails(
      ["worker", "--graph", graphPath, "--isolation", "git", "--remote", "TODO", "--once", "--quiet"],
      /Worker isolation remote is a placeholder and cannot be used: TODO/
    );
    await assertCliFails(
      ["worker", "--graph", graphPath, "--isolation", "git", "--remote", "git@example.com:org/repo.git", "--cwd", dirname(graphPath), "--once", "--quiet"],
      /Cannot combine --cwd with --isolation git; use --workspace-root to choose isolated clone placement\./
    );

    const unchanged = await readGraph(graphPath);
    assert.equal(unchanged.graph.nodes.A.status, "pending");
    assert.equal(unchanged.graph.nodes.A.lease, undefined);
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

test("worker planner preflight executes atomic task decisions normally", async () => {
  await withTempGraph(async (graphPath, dir) => {
    const graph = await readGraph(graphPath);
    graph.scheduler.workerPlanner = { mode: "auto-decompose" };
    await writeFile(graphPath, `${JSON.stringify(graph, null, 2)}\n`, "utf8");

    const fakeRunnerPath = join(dir, "fake-planner-atomic-runner.mjs");
    await writeFile(fakeRunnerPath, "console.log('atomic planner decision executed codex');\n", "utf8");

    const planner = createFixturePlannerRuntime((request) => {
      assert.equal(request.nodeId, "A");
      return { kind: "task", title: "Keep A atomic" };
    });
    const result = await runWorker(graphPath, {
      session: "codex-planner-atomic",
      once: true,
      cwd: dir,
      stream: false,
      codexCommand: process.execPath,
      codexArgs: [fakeRunnerPath],
      planner
    });

    assert.equal(result.results[0].nodeId, "A");
    assert.equal(result.results[0].status, "done");
    const updated = await readGraph(graphPath);
    assert.equal(updated.graph.nodes.A.status, "done");
    assert.equal(updated.graph.nodes.A.workerPlanner.decision, "task");
    assert.equal(updated.graph.nodes.A.workerPlanner.decisionStatus, "planned");
    assert.equal(updated.graph.nodes.A.workerPlanner.attemptCount, 1);
    assert.equal(updated.graph.nodes.A.workerPlanner.maxAttempts, 1);
    assert.match(updated.graph.nodes.A.workerPlanner.requestId, /^worker-plan-A-run_/);
    const report = await readFile(join(dir, updated.graph.nodes.A.report), "utf8");
    assert.match(report, /atomic planner decision executed codex/);
  });
});

test("worker planner preflight reuses persisted atomic decisions without calling planner again", async () => {
  await withTempGraph(async (graphPath, dir) => {
    const graph = await readGraph(graphPath);
    graph.scheduler.workerPlanner = { mode: "auto-decompose" };
    graph.graph.nodes.A.workerPlanner = {
      decision: "task",
      decisionStatus: "planned",
      requestId: "persisted-task-decision",
      attemptCount: 1,
      maxAttempts: 1,
      attempts: [{
        requestId: "persisted-task-decision",
        status: "planned",
        decision: "task",
        attemptedAt: "2026-05-31T00:00:00.000Z"
      }]
    };
    await writeFile(graphPath, `${JSON.stringify(graph, null, 2)}\n`, "utf8");

    const fakeRunnerPath = join(dir, "fake-persisted-atomic-runner.mjs");
    await writeFile(fakeRunnerPath, "console.log('persisted atomic decision executed codex');\n", "utf8");

    const result = await runWorker(graphPath, {
      session: "codex-planner-persisted-atomic",
      once: true,
      cwd: dir,
      stream: false,
      codexCommand: process.execPath,
      codexArgs: [fakeRunnerPath],
      planner: {
        async plan() {
          throw new Error("planner should not be called for persisted task decisions");
        }
      }
    });

    assert.equal(result.results[0].status, "done");
    const updated = await readGraph(graphPath);
    assert.equal(updated.graph.nodes.A.workerPlanner.attemptCount, 1);
    const report = await readFile(join(dir, updated.graph.nodes.A.report), "utf8");
    assert.match(report, /persisted atomic decision executed codex/);
  });
});

test("worker planner preflight auto-decomposes series decisions before Codex", async () => {
  await withTempGraph(async (graphPath, dir) => {
    const graph = await readGraph(graphPath);
    graph.scheduler.workerPlanner = { mode: "auto-decompose" };
    await writeFile(graphPath, `${JSON.stringify(graph, null, 2)}\n`, "utf8");

    const markerPath = join(dir, "planner-series-codex-ran");
    const fakeRunnerPath = join(dir, "fake-planner-series-runner.mjs");
    await writeFile(fakeRunnerPath, `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(markerPath)}, 'ran');\n`, "utf8");

    const planner = createFixturePlannerRuntime({
      kind: "series",
      title: "Split A in order",
      children: [
        { id: "A_PLAN_1", title: "Prepare A" },
        { id: "A_PLAN_2", title: "Implement A" }
      ]
    });
    const result = await runWorker(graphPath, {
      session: "codex-planner-series",
      once: true,
      cwd: dir,
      stream: false,
      codexCommand: process.execPath,
      codexArgs: [fakeRunnerPath],
      planner
    });

    assert.equal(result.results[0].nodeId, "A");
    assert.equal(result.results[0].status, "pending");
    assert.equal(result.results[0].note, "planner decomposed node as series");
    assert.equal(existsSync(markerPath), false);
    const updated = await readGraph(graphPath);
    assert.equal(updated.graph.nodes.A.kind, "series");
    assert.equal(updated.graph.nodes.A.status, "pending");
    assert.deepEqual(updated.graph.nodes.A.children, ["A_PLAN_1", "A_PLAN_2"]);
    assert.equal(updated.graph.nodes.A.lease, undefined);
    assert.equal(updated.graph.nodes.A.workerPlanner.decision, "series");
    assert.equal(updated.graph.nodes.A.workerPlanner.decisionStatus, "planned");
    assert.deepEqual(updated.graph.nodes.A.workerPlanner.childIds, ["A_PLAN_1", "A_PLAN_2"]);
    assert.deepEqual(listReadyLeafNodes(updated).map((node) => node.id), ["A_PLAN_1"]);
  });
});

test("worker planner preflight auto-decomposes parallel decisions before Codex", async () => {
  await withTempGraph(async (graphPath, dir) => {
    const graph = await readGraph(graphPath);
    graph.scheduler.workerPlanner = { mode: "auto-decompose" };
    await writeFile(graphPath, `${JSON.stringify(graph, null, 2)}\n`, "utf8");

    const markerPath = join(dir, "planner-parallel-codex-ran");
    const fakeRunnerPath = join(dir, "fake-planner-parallel-runner.mjs");
    await writeFile(fakeRunnerPath, `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(markerPath)}, 'ran');\n`, "utf8");

    const planner = createFixturePlannerRuntime({
      kind: "parallel",
      title: "Split A independently",
      children: [
        { id: "A_LEFT", title: "Left A" },
        { id: "A_RIGHT", title: "Right A" }
      ]
    });
    const result = await runWorker(graphPath, {
      session: "codex-planner-parallel",
      once: true,
      cwd: dir,
      stream: false,
      codexCommand: process.execPath,
      codexArgs: [fakeRunnerPath],
      planner
    });

    assert.equal(result.results[0].status, "pending");
    assert.equal(result.results[0].note, "planner decomposed node as parallel");
    assert.equal(existsSync(markerPath), false);
    const updated = await readGraph(graphPath);
    assert.equal(updated.graph.nodes.A.kind, "parallel");
    assert.deepEqual(updated.graph.nodes.A.children, ["A_LEFT", "A_RIGHT"]);
    assert.deepEqual(listReadyLeafNodes(updated).map((node) => node.id), ["A_LEFT", "A_RIGHT"]);
  });
});

test("worker planner preflight recursively plans decomposed auto-decompose leaves", async () => {
  await withTempGraph(async (graphPath, dir) => {
    const graph = await readGraph(graphPath);
    graph.scheduler.workerPlanner = { mode: "auto-decompose" };
    await writeFile(graphPath, `${JSON.stringify(graph, null, 2)}\n`, "utf8");

    const executionLogPath = join(dir, "recursive-auto-executions.log");
    const fakeRunnerPath = join(dir, "fake-recursive-auto-runner.mjs");
    await writeFile(
      fakeRunnerPath,
      [
        "import { appendFileSync } from 'node:fs';",
        "const prompt = process.argv.at(-1) || '';",
        "const node = prompt.match(/^- Node: ([^\\n]+)/m)?.[1] || 'missing-node';",
        `appendFileSync(${JSON.stringify(executionLogPath)}, node + '\\n');`,
        "console.log(`executed ${node}`);"
      ].join("\n"),
      "utf8"
    );

    const plannerCalls = [];
    const planner = createFixturePlannerRuntime((request) => {
      plannerCalls.push(request.nodeId);
      if (request.nodeId === "A") {
        return {
          kind: "series",
          title: "Split A recursively",
          children: [
            { id: "A_DESIGN", title: "Design A" },
            { id: "A_BUILD", title: "Build A" }
          ]
        };
      }
      return { kind: "task", title: `Keep ${request.nodeId} atomic` };
    });

    const commonOptions = {
      once: true,
      cwd: dir,
      stream: false,
      codexCommand: process.execPath,
      codexArgs: [fakeRunnerPath],
      planner
    };

    const decomposed = await runWorker(graphPath, {
      ...commonOptions,
      session: "codex-recursive-auto-parent"
    });
    assert.equal(decomposed.results[0].nodeId, "A");
    assert.equal(decomposed.results[0].status, "pending");
    assert.equal(decomposed.results[0].note, "planner decomposed node as series");
    assert.equal(existsSync(executionLogPath), false);

    const firstLeaf = await runWorker(graphPath, {
      ...commonOptions,
      session: "codex-recursive-auto-design"
    });
    assert.equal(firstLeaf.results[0].nodeId, "A_DESIGN");
    assert.equal(firstLeaf.results[0].status, "done");

    const secondLeaf = await runWorker(graphPath, {
      ...commonOptions,
      session: "codex-recursive-auto-build"
    });
    assert.equal(secondLeaf.results[0].nodeId, "A_BUILD");
    assert.equal(secondLeaf.results[0].status, "done");

    assert.deepEqual(plannerCalls, ["A", "A_DESIGN", "A_BUILD"]);
    assert.deepEqual((await readFile(executionLogPath, "utf8")).trim().split("\n"), ["A_DESIGN", "A_BUILD"]);
    const updated = await readGraph(graphPath);
    assert.equal(updated.graph.nodes.A.status, "done");
    assert.equal(updated.graph.nodes.A_DESIGN.workerPlanner.decision, "task");
    assert.equal(updated.graph.nodes.A_BUILD.workerPlanner.decision, "task");
    assert.deepEqual(listReadyLeafNodes(updated).map((node) => node.id), ["B", "C"]);
  });
});

test("worker CLI fixture planner mode auto-decomposes without network access", async () => {
  await withTempGraph(async (graphPath, dir) => {
    const fixturePath = join(dir, "planner-fixture.json");
    await writeFile(fixturePath, JSON.stringify({
      kind: "series",
      title: "CLI fixture split",
      children: [
        { id: "A_FIXTURE_PLAN", title: "Plan fixture child" },
        { id: "A_FIXTURE_VERIFY", title: "Verify fixture child" }
      ]
    }, null, 2), "utf8");

    const markerPath = join(dir, "cli-fixture-codex-ran");
    const fakeRunnerPath = join(dir, "fake-cli-fixture-runner.mjs");
    await writeFile(fakeRunnerPath, `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(markerPath)}, 'ran');\n`, "utf8");

    const { stdout } = await execFileAsync(process.execPath, [
      schedulerScriptPath,
      "worker",
      "--graph", graphPath,
      "--session", "codex-cli-fixture",
      "--once",
      "--quiet",
      "--planner-mode", "auto-decompose",
      "--planner-adapter", "fixture",
      "--planner-fixture", fixturePath,
      "--codex-command", process.execPath,
      "--codex-arg", fakeRunnerPath
    ]);

    const result = JSON.parse(stdout);
    assert.equal(result.results[0].note, "planner decomposed node as series");
    assert.equal(existsSync(markerPath), false);
    const updated = await readGraph(graphPath);
    assert.equal(updated.graph.nodes.A.status, "pending");
    assert.deepEqual(updated.graph.nodes.A.children, ["A_FIXTURE_PLAN", "A_FIXTURE_VERIFY"]);
    assert.deepEqual(listReadyLeafNodes(updated).map((node) => node.id), ["A_FIXTURE_PLAN"]);
  });
});

test("worker CLI fixture planner mode auto-decomposes generated goal tasks", async () => {
  const { dir, graphPath } = await copyGraphFixtureToTemp("valid-generated-goal.graph.json");
  try {
    const fixturePath = join(dir, "generated-planner-fixture.json");
    await writeFile(fixturePath, JSON.stringify({
      kind: "series",
      title: "CLI generated goal split",
      children: [
        { id: "PLAN_CLI_DISCOVER", title: "Discover generated CLI path" },
        { id: "PLAN_CLI_VERIFY", title: "Verify generated CLI path" }
      ]
    }, null, 2), "utf8");

    const markerPath = join(dir, "generated-cli-fixture-codex-ran");
    const fakeRunnerPath = join(dir, "fake-generated-cli-fixture-runner.mjs");
    await writeFile(fakeRunnerPath, `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(markerPath)}, 'ran');\n`, "utf8");

    const { stdout } = await execFileAsync(process.execPath, [
      schedulerScriptPath,
      "worker",
      "--graph", graphPath,
      "--session", "codex-cli-generated-fixture",
      "--once",
      "--quiet",
      "--planner-mode", "auto-decompose",
      "--planner-adapter", "fixture",
      "--planner-fixture", "generated-planner-fixture.json",
      "--planner-request-id-prefix", "cli-fixture-plan",
      "--codex-command", process.execPath,
      "--codex-arg", fakeRunnerPath
    ]);

    const result = JSON.parse(stdout);
    assert.equal(result.results[0].nodeId, "PLAN");
    assert.equal(result.results[0].note, "planner decomposed node as series");
    assert.equal(existsSync(markerPath), false);
    const updated = await readGraph(graphPath);
    assert.equal(updated.graph.nodes.PLAN.kind, "series");
    assert.equal(updated.graph.nodes.PLAN.status, "pending");
    assert.deepEqual(updated.graph.nodes.PLAN.children, ["PLAN_CLI_DISCOVER", "PLAN_CLI_VERIFY"]);
    assert.deepEqual(listReadyLeafNodes(updated).map((node) => node.id), ["PLAN_CLI_DISCOVER"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("worker CLI planner mode off preserves normal worker execution", async () => {
  await withTempGraph(async (graphPath, dir) => {
    const fakeRunnerPath = join(dir, "fake-planner-off-runner.mjs");
    await writeFile(fakeRunnerPath, "console.log('planner off ran normal worker');\n", "utf8");

    const { stdout } = await execFileAsync(process.execPath, [
      schedulerScriptPath,
      "worker",
      "--graph", graphPath,
      "--session", "codex-cli-planner-off",
      "--once",
      "--quiet",
      "--planner-mode", "off",
      "--codex-command", process.execPath,
      "--codex-arg", fakeRunnerPath
    ]);

    const result = JSON.parse(stdout);
    assert.equal(result.results[0].nodeId, "A");
    assert.equal(result.results[0].status, "done");
    const updated = await readGraph(graphPath);
    assert.equal(updated.graph.nodes.A.status, "done");
    assert.equal(updated.graph.nodes.A.children, undefined);
    const report = await readFile(join(dir, updated.graph.nodes.A.report), "utf8");
    assert.match(report, /planner off ran normal worker/);
  });
});

test("worker CLI rejects invalid planner mode before claiming work", async () => {
  await withTempGraph(async (graphPath) => {
    await assertCliFails(
      ["worker", "--graph", graphPath, "--planner-mode", "sometimes", "--once", "--quiet"],
      /Invalid worker planner mode: expected off, auto-decompose, or ask-approval; received "sometimes"/
    );

    const updated = await readGraph(graphPath);
    assert.equal(updated.graph.nodes.A.status, "pending");
    assert.equal(updated.graph.nodes.A.lease, undefined);
    assert.equal(updated.graph.nodes.A.history, undefined);
  });
});

test("worker prompt planner adapter uses configured template boundary without provider coupling", async () => {
  await withTempGraph(async (graphPath, dir) => {
    const graph = await readGraph(graphPath);
    graph.scheduler.workerPlanner = { mode: "auto-decompose", adapterMode: "prompt", templatePath: "planner-template.md" };
    await writeFile(graphPath, `${JSON.stringify(graph, null, 2)}\n`, "utf8");
    await writeFile(join(dir, "planner-template.md"), "Prompt boundary for {{goal}}\n{{requestJson}}\n", "utf8");

    const fakeRunnerPath = join(dir, "fake-prompt-planner-runner.mjs");
    await writeFile(fakeRunnerPath, "console.log('prompt planner task executed codex');\n", "utf8");

    let sawPrompt = false;
    const result = await runWorker(graphPath, {
      session: "codex-prompt-planner",
      once: true,
      cwd: dir,
      stream: false,
      codexCommand: process.execPath,
      codexArgs: [fakeRunnerPath],
      promptPlannerAdapter: {
        async complete({ prompt, request }) {
          sawPrompt = true;
          assert.equal(request.nodeId, "A");
          assert.match(prompt, /Prompt boundary for Bootstrap/);
          assert.match(prompt, /"requestId": "worker-plan-A-run_/);
          return JSON.stringify({ kind: "task", title: "Keep prompt-planned work atomic" });
        }
      }
    });

    assert.equal(sawPrompt, true);
    assert.equal(result.results[0].status, "done");
    const updated = await readGraph(graphPath);
    const report = await readFile(join(dir, updated.graph.nodes.A.report), "utf8");
    assert.match(report, /prompt planner task executed codex/);
  });
});

test("worker planner preflight decomposes generated goal fixtures deterministically", async () => {
  const { dir, graphPath } = await copyGraphFixtureToTemp("valid-generated-goal.graph.json");
  try {
    const graph = await readGraph(graphPath);
    graph.scheduler.workerPlanner = {
      mode: "auto-decompose",
      requestIdPrefix: "fixture-plan"
    };
    await writeFile(graphPath, `${JSON.stringify(graph, null, 2)}\n`, "utf8");

    const markerPath = join(dir, "generated-fixture-codex-ran");
    const fakeRunnerPath = join(dir, "fake-generated-fixture-runner.mjs");
    await writeFile(fakeRunnerPath, `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(markerPath)}, 'ran');\n`, "utf8");

    const planner = createFixturePlannerRuntime((request) => {
      assert.equal(request.nodeId, "PLAN");
      assert.equal(request.goal, "Build fixture resume coverage");
      assert.match(request.requestId, /^fixture-plan-PLAN-run_/);
      return {
        kind: "series",
        title: "Split generated goal",
        children: [
          {
            id: "PLAN_DISCOVER",
            title: "Discover resume path",
            goal: { text: "Build fixture resume coverage", source: "planner" }
          },
          {
            id: "PLAN_VERIFY",
            title: "Verify replay path",
            goal: { text: "Build fixture resume coverage", source: "planner" }
          }
        ]
      };
    });
    const result = await runWorker(graphPath, {
      session: "codex-generated-planner",
      once: true,
      cwd: dir,
      stream: false,
      codexCommand: process.execPath,
      codexArgs: [fakeRunnerPath],
      planner
    });

    assert.equal(result.results[0].nodeId, "PLAN");
    assert.equal(result.results[0].status, "pending");
    assert.equal(result.results[0].note, "planner decomposed node as series");
    assert.equal(existsSync(markerPath), false);
    const updated = await readGraph(graphPath);
    assert.equal(updated.graph.nodes.PLAN.kind, "series");
    assert.deepEqual(updated.graph.nodes.PLAN.children, ["PLAN_DISCOVER", "PLAN_VERIFY"]);
    assert.equal(updated.graph.nodes.PLAN_DISCOVER.goal.text, "Build fixture resume coverage");
    assert.equal(updated.graph.nodes.PLAN_DISCOVER.goal.source, "planner");
    assert.deepEqual(listReadyLeafNodes(updated).map((node) => node.id), ["PLAN_DISCOVER"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("worker planner preflight ask-approval blocks valid decomposition proposals", async () => {
  await withTempGraph(async (graphPath, dir) => {
    const graph = await readGraph(graphPath);
    graph.scheduler.workerPlanner = { mode: "ask-approval" };
    await writeFile(graphPath, `${JSON.stringify(graph, null, 2)}\n`, "utf8");

    const markerPath = join(dir, "planner-approval-codex-ran");
    const fakeRunnerPath = join(dir, "fake-planner-approval-runner.mjs");
    await writeFile(fakeRunnerPath, `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(markerPath)}, 'ran');\n`, "utf8");

    const planner = createFixturePlannerRuntime({
      kind: "series",
      title: "Needs operator approval",
      children: [{ id: "A_APPROVED", title: "Approved child" }]
    });
    const result = await runWorker(graphPath, {
      session: "codex-planner-approval",
      once: true,
      cwd: dir,
      stream: false,
      codexCommand: process.execPath,
      codexArgs: [fakeRunnerPath],
      planner
    });

    assert.equal(result.results[0].status, "blocked");
    assert.equal(result.results[0].code, 0);
    assert.equal(existsSync(markerPath), false);
    const updated = await readGraph(graphPath);
    assert.equal(updated.graph.nodes.A.kind, "task");
    assert.equal(updated.graph.nodes.A.children, undefined);
    assert.equal(updated.graph.nodes.A.status, "blocked");
    assert.match(updated.graph.nodes.A.question, /Planner proposed series decomposition/);
    assert.match(updated.graph.nodes.A.question, /Approve with decompose --node A/);
    assert.match(updated.graph.nodes.A.question, /Regenerate by resetting this node/);
    assert.match(updated.graph.nodes.A.pendingPlannerPreview.requestId, /^worker-plan-A-run_/);
    assert.equal(updated.graph.nodes.A.pendingPlannerPreview.proposedKind, "series");
    assert.equal(updated.graph.nodes.A.pendingPlannerPreview.graphVersion, updated.graphVersion);
    assert.equal(updated.graph.nodes.A.pendingPlannerPreview.nodeState.status, "blocked");
    assert.deepEqual(updated.graph.nodes.A.pendingPlannerPreview.childIds, ["A_APPROVED"]);
    assert.deepEqual(updated.graph.nodes.A.pendingPlannerPreview.decompose.children.map((child) => child.title), ["Approved child"]);
    const previewEvent = updated.graph.nodes.A.history.find((event) => event.event === operationalEvents.plannerPreviewRejected);
    assert.equal(previewEvent.status, "blocked");
    assert.equal(previewEvent.proposedKind, "series");
    assert.deepEqual(previewEvent.childIds, ["A_APPROVED"]);
    assert.match(previewEvent.requestId, /^worker-plan-A-run_/);
    const report = await readFile(join(dir, updated.graph.nodes.A.report), "utf8");
    assert.match(report, /Planner preflight: A/);
    assert.match(report, /Proposed Children/);
    assert.match(report, /Approved child/);
    assert.match(report, /A_APPROVED/);

    await decomposeNode(graphPath, {
      nodeId: "A",
      session: "codex-planner-approval",
      runId: result.results[0].runId,
      kind: "series",
      children: [{ id: "A_APPROVED", title: "Approved child" }]
    });
    const decomposed = await readGraph(graphPath);
    assert.equal(decomposed.graph.nodes.A.status, "pending");
    assert.deepEqual(decomposed.graph.nodes.A.children, ["A_APPROVED"]);
    assert.equal(decomposed.graph.nodes.A.pendingPlannerPreview, undefined);
  });
});

test("worker planner preflight executes approved decomposition leaves after ask-approval", async () => {
  await withTempGraph(async (graphPath, dir) => {
    const graph = await readGraph(graphPath);
    graph.scheduler.workerPlanner = { mode: "ask-approval" };
    await writeFile(graphPath, `${JSON.stringify(graph, null, 2)}\n`, "utf8");

    const executionLogPath = join(dir, "recursive-approval-executions.log");
    const fakeRunnerPath = join(dir, "fake-recursive-approval-runner.mjs");
    await writeFile(
      fakeRunnerPath,
      [
        "import { appendFileSync } from 'node:fs';",
        "const prompt = process.argv.at(-1) || '';",
        "const node = prompt.match(/^- Node: ([^\\n]+)/m)?.[1] || 'missing-node';",
        `appendFileSync(${JSON.stringify(executionLogPath)}, node + '\\n');`,
        "console.log(`approved leaf executed ${node}`);"
      ].join("\n"),
      "utf8"
    );

    const plannerCalls = [];
    const planner = createFixturePlannerRuntime((request) => {
      plannerCalls.push(request.nodeId);
      if (request.nodeId === "A") {
        return {
          kind: "series",
          title: "Approve recursive split",
          children: [{ id: "A_APPROVED_LEAF", title: "Approved leaf" }]
        };
      }
      return { kind: "task", title: "Run approved leaf atomically" };
    });

    const blocked = await runWorker(graphPath, {
      session: "codex-recursive-approval-parent",
      once: true,
      cwd: dir,
      stream: false,
      codexCommand: process.execPath,
      codexArgs: [fakeRunnerPath],
      planner
    });
    assert.equal(blocked.results[0].nodeId, "A");
    assert.equal(blocked.results[0].status, "blocked");
    assert.equal(existsSync(executionLogPath), false);

    await applyPlannerPreview(graphPath, {
      nodeId: "A",
      session: "codex-recursive-approval-parent",
      runId: blocked.results[0].runId
    });
    const afterApproval = await readGraph(graphPath);
    assert.equal(afterApproval.graph.nodes.A.status, "pending");
    assert.deepEqual(afterApproval.graph.nodes.A.children, ["A_APPROVED_LEAF"]);
    assert.deepEqual(listReadyLeafNodes(afterApproval).map((node) => node.id), ["A_APPROVED_LEAF"]);

    const leaf = await runWorker(graphPath, {
      session: "codex-recursive-approval-leaf",
      once: true,
      cwd: dir,
      stream: false,
      codexCommand: process.execPath,
      codexArgs: [fakeRunnerPath],
      planner
    });
    assert.equal(leaf.results[0].nodeId, "A_APPROVED_LEAF");
    assert.equal(leaf.results[0].status, "done");

    assert.deepEqual(plannerCalls, ["A", "A_APPROVED_LEAF"]);
    assert.equal((await readFile(executionLogPath, "utf8")).trim(), "A_APPROVED_LEAF");
    const updated = await readGraph(graphPath);
    assert.equal(updated.graph.nodes.A.status, "done");
    assert.equal(updated.graph.nodes.A.pendingPlannerPreview, undefined);
    assert.equal(updated.graph.nodes.A_APPROVED_LEAF.workerPlanner.decision, "task");
  });
});

test("stored planner previews can be applied or rejected explicitly", async () => {
  await withTempGraph(async (graphPath) => {
    const planner = createFixturePlannerRuntime({
      kind: "series",
      title: "Needs approval",
      children: [{ id: "A_PREVIEW", title: "Preview child" }]
    });
    const result = await runWorker(graphPath, {
      session: "codex-preview-apply",
      nodeId: "A",
      once: true,
      stream: false,
      plannerMode: "ask-approval",
      planner
    });
    assert.equal(result.results[0].status, "blocked");

    const applied = await applyPlannerPreview(graphPath, {
      nodeId: "A",
      session: "codex-preview-apply",
      runId: result.results[0].runId
    });
    assert.deepEqual(applied.children, ["A_PREVIEW"]);
    const appliedGraph = await readGraph(graphPath);
    assert.equal(appliedGraph.graph.nodes.A.pendingPlannerPreview, undefined);
    assert.equal(appliedGraph.graph.nodes.A_PREVIEW.title, "Preview child");
    assert.equal(appliedGraph.graph.nodes.A.history.at(-1).event, operationalEvents.plannerPreviewApplied);
  });

  await withTempGraph(async (graphPath) => {
    const planner = createFixturePlannerRuntime({
      kind: "parallel",
      title: "Reject approval",
      children: [{ id: "A_REJECTED", title: "Rejected child" }]
    });
    const result = await runWorker(graphPath, {
      session: "codex-preview-reject",
      nodeId: "A",
      once: true,
      stream: false,
      plannerMode: "ask-approval",
      planner
    });
    assert.equal(result.results[0].status, "blocked");

    const rejected = await rejectPlannerPreview(graphPath, {
      nodeId: "A",
      reason: "operator rejected test preview",
      responder: "test"
    });
    assert.equal(rejected.status, "pending");
    assert.deepEqual(rejected.childIds, ["A_REJECTED"]);
    const rejectedGraph = await readGraph(graphPath);
    assert.equal(rejectedGraph.graph.nodes.A.pendingPlannerPreview, undefined);
    assert.equal(rejectedGraph.graph.nodes.A.children, undefined);
    assert.equal(rejectedGraph.graph.nodes.A_REJECTED, undefined);
    assert.equal(rejectedGraph.graph.nodes.A.lease, undefined);
    assert.equal(rejectedGraph.graph.nodes.A.history.at(-1).event, operationalEvents.plannerPreviewRejected);
    assert.equal(rejectedGraph.graph.nodes.A.history.at(-1).reason, "operator rejected test preview");
  });
});

test("approval-gated planner previews reject stale graph versions and changed node state", async () => {
  await withTempGraph(async (graphPath) => {
    const graph = {
      graphVersion: 1,
      scheduler: { leaseSeconds: 60 },
      graph: {
        root: "ROOT",
        nodes: {
          ROOT: { title: "Root", kind: "parallel", status: "pending", children: ["A", "B"] },
          A: { title: "Approve preview", kind: "task", status: "pending" },
          B: { title: "Independent work", kind: "task", status: "pending" }
        }
      }
    };
    await writeFile(graphPath, `${JSON.stringify(graph, null, 2)}\n`, "utf8");

    const planner = createFixturePlannerRuntime({
      kind: "series",
      title: "Needs approval",
      children: [{
        id: "A_APPROVED",
        title: "Approved child",
        deliverables: ["Preview child deliverable"],
        acceptanceCriteria: ["Preview child acceptance"]
      }]
    });
    const result = await runWorker(graphPath, {
      session: "codex-planner-stale",
      nodeId: "A",
      once: true,
      stream: false,
      plannerMode: "ask-approval",
      planner
    });
    assert.equal(result.results[0].status, "blocked");

    await claimNode(graphPath, { session: "codex-other", nodeId: "B" });
    await assert.rejects(
      decomposeNode(graphPath, {
        nodeId: "A",
        session: "codex-planner-stale",
        runId: result.results[0].runId,
        kind: "series",
        children: [{
          id: "A_APPROVED",
          title: "Approved child",
          deliverables: ["Preview child deliverable"],
          acceptanceCriteria: ["Preview child acceptance"]
        }]
      }),
      /Stale planner preview for A: graphVersion changed/
    );

    const staleGraph = await readGraph(graphPath);
    assert.equal(staleGraph.graph.nodes.A.children, undefined);
    staleGraph.graph.nodes.A.pendingPlannerPreview.graphVersion = staleGraph.graphVersion;
    staleGraph.graph.nodes.A.question = "Edited approval text";
    await writeFile(graphPath, `${JSON.stringify(staleGraph, null, 2)}\n`, "utf8");

    await assert.rejects(
      decomposeNode(graphPath, {
        nodeId: "A",
        session: "codex-planner-stale",
        runId: result.results[0].runId,
        kind: "series",
        children: [{
          id: "A_APPROVED",
          title: "Approved child",
          deliverables: ["Preview child deliverable"],
          acceptanceCriteria: ["Preview child acceptance"]
        }]
      }),
      /Stale planner preview for A: node state changed/
    );
  });
});

test("worker planner preflight fails invalid planner output by policy", async () => {
  await withTempGraph(async (graphPath, dir) => {
    const graph = await readGraph(graphPath);
    graph.scheduler.workerPlanner = { mode: "auto-decompose", failurePolicy: "fail" };
    await writeFile(graphPath, `${JSON.stringify(graph, null, 2)}\n`, "utf8");

    const markerPath = join(dir, "planner-invalid-codex-ran");
    const fakeRunnerPath = join(dir, "fake-planner-invalid-runner.mjs");
    await writeFile(fakeRunnerPath, `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(markerPath)}, 'ran');\n`, "utf8");

    const planner = {
      async plan(request) {
        return {
          requestId: request.requestId,
          response: {
            kind: "series",
            title: "Invalid duplicate child",
            children: [
              { id: "A_INVALID", title: "First proposed child" },
              { id: "A_INVALID", title: "Duplicate proposed child" }
            ]
          }
        };
      }
    };
    const result = await runWorker(graphPath, {
      session: "codex-planner-invalid",
      once: true,
      cwd: dir,
      stream: false,
      codexCommand: process.execPath,
      codexArgs: [fakeRunnerPath],
      planner
    });

    assert.equal(result.results[0].status, "failed");
    assert.equal(result.results[0].code, 1);
    assert.equal(existsSync(markerPath), false);
    const updated = await readGraph(graphPath);
    assert.equal(updated.graph.nodes.A.status, "failed");
    assert.match(updated.graph.nodes.A.failureReason, /planner failed: Invalid planner response/);
    assert.equal(updated.graph.nodes.A.children, undefined);
    assert.equal(Object.hasOwn(updated.graph.nodes, "A_INVALID"), false);
    const plannerFailedEvent = updated.graph.nodes.A.history.find((event) => event.event === operationalEvents.plannerFailed);
    assert.equal(plannerFailedEvent.status, "failed");
    assert.equal(plannerFailedEvent.failurePolicy, "fail");
    assert.match(plannerFailedEvent.requestId, /^worker-plan-A-run_/);
    assert.match(plannerFailedEvent.reason, /Invalid planner response/);
    const report = await readFile(join(dir, updated.graph.nodes.A.report), "utf8");
    assert.match(report, /duplicate-child-id/);
  });
});

test("worker planner preflight rejects missing adapter configuration before mutation", async () => {
  await withTempGraph(async (graphPath, dir) => {
    const graph = await readGraph(graphPath);
    graph.scheduler.workerPlanner = { mode: "auto-decompose" };
    await writeFile(graphPath, `${JSON.stringify(graph, null, 2)}\n`, "utf8");

    const markerPath = join(dir, "planner-missing-codex-ran");
    const fakeRunnerPath = join(dir, "fake-planner-missing-runner.mjs");
    await writeFile(fakeRunnerPath, `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(markerPath)}, 'ran');\n`, "utf8");

    await assert.rejects(
      runWorker(graphPath, {
        session: "codex-planner-missing",
        once: true,
        cwd: dir,
        stream: false,
        codexCommand: process.execPath,
        codexArgs: [fakeRunnerPath]
      }),
      /Invalid worker planner configuration: planner mode requires --planner-adapter fixture\|prompt or an injected planner runtime/
    );

    assert.equal(existsSync(markerPath), false);
    const updated = await readGraph(graphPath);
    assert.equal(updated.graph.nodes.A.status, "pending");
    assert.equal(updated.graph.nodes.A.lease, undefined);
    assert.equal(updated.graph.nodes.A.history, undefined);
    assert.equal(updated.graphVersion, graph.graphVersion);
  });
});

test("worker planner preflight blocks runtime planner failures by default", async () => {
  await withTempGraph(async (graphPath, dir) => {
    const graph = await readGraph(graphPath);
    graph.scheduler.workerPlanner = { mode: "auto-decompose" };
    await writeFile(graphPath, `${JSON.stringify(graph, null, 2)}\n`, "utf8");

    const markerPath = join(dir, "planner-throwing-codex-ran");
    const fakeRunnerPath = join(dir, "fake-planner-throwing-runner.mjs");
    await writeFile(fakeRunnerPath, `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(markerPath)}, 'ran');\n`, "utf8");

    const result = await runWorker(graphPath, {
      session: "codex-planner-throwing",
      once: true,
      cwd: dir,
      stream: false,
      codexCommand: process.execPath,
      codexArgs: [fakeRunnerPath],
      planner: {
        async plan() {
          throw new Error("planner adapter unavailable");
        }
      }
    });

    assert.equal(result.results[0].status, "blocked");
    assert.equal(result.results[0].code, 1);
    assert.equal(existsSync(markerPath), false);
    const updated = await readGraph(graphPath);
    assert.equal(updated.graph.nodes.A.status, "blocked");
    assert.match(updated.graph.nodes.A.blockedReason, /planner failed: planner adapter unavailable/);
    const plannerFailedEvent = updated.graph.nodes.A.history.find((event) => event.event === operationalEvents.plannerFailed);
    assert.equal(plannerFailedEvent.status, "blocked");
    assert.equal(plannerFailedEvent.failurePolicy, "block");
    assert.match(plannerFailedEvent.reason, /planner adapter unavailable/);
    const report = await readFile(join(dir, updated.graph.nodes.A.report), "utf8");
    assert.match(report, /Planner failure: A/);
  });
});

test("worker planner preflight blocks clearly when planning attempts are exhausted", async () => {
  await withTempGraph(async (graphPath, dir) => {
    const graph = await readGraph(graphPath);
    graph.scheduler.workerPlanner = { mode: "auto-decompose", maxAttempts: 1 };
    graph.graph.nodes.A.workerPlanner = {
      attemptCount: 1,
      maxAttempts: 1,
      attempts: [{
        requestId: "prior-failed-plan",
        status: "failed",
        attemptedAt: "2026-05-31T00:00:00.000Z",
        reason: "planner failed previously"
      }]
    };
    await writeFile(graphPath, `${JSON.stringify(graph, null, 2)}\n`, "utf8");

    const markerPath = join(dir, "planner-limit-codex-ran");
    const fakeRunnerPath = join(dir, "fake-planner-limit-runner.mjs");
    await writeFile(fakeRunnerPath, `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(markerPath)}, 'ran');\n`, "utf8");

    let plannerCalls = 0;
    const result = await runWorker(graphPath, {
      session: "codex-planner-limit",
      once: true,
      cwd: dir,
      stream: false,
      codexCommand: process.execPath,
      codexArgs: [fakeRunnerPath],
      planner: {
        async plan() {
          plannerCalls += 1;
          return { requestId: "unexpected", response: { kind: "task", title: "Unexpected" } };
        }
      }
    });

    assert.equal(plannerCalls, 0);
    assert.equal(result.results[0].status, "blocked");
    assert.equal(result.results[0].code, 1);
    assert.equal(existsSync(markerPath), false);
    const updated = await readGraph(graphPath);
    assert.equal(updated.graph.nodes.A.status, "blocked");
    assert.match(updated.graph.nodes.A.blockedReason, /planner failed: planner attempt limit exceeded for A: 1\/1/);
    assert.equal(updated.graph.nodes.A.workerPlanner.decisionStatus, "limit-exceeded");
    assert.equal(updated.graph.nodes.A.workerPlanner.attemptCount, 2);
    const report = await readFile(join(dir, updated.graph.nodes.A.report), "utf8");
    assert.match(report, /planner attempt limit exceeded for A: 1\/1/);
  });
});

test("worker marks node failed when done finalization cannot record required output ref", async () => {
  await withTempGraph(async (graphPath, dir) => {
    const graph = fixtureGraph();
    graph.graph.nodes = {
      ROOT: { title: "Root", kind: "parallel", status: "pending", children: ["A", "B"] },
      A: { title: "Shared worker", kind: "task", status: "pending" },
      B: {
        title: "Isolated sibling",
        kind: "task",
        status: "done",
        outputRef: { name: "refs/heads/spg/node/B/run-b", commit: "b".repeat(40) }
      }
    };
    await writeFile(graphPath, `${JSON.stringify(graph, null, 2)}\n`, "utf8");

    const fakeRunnerPath = join(dir, "fake-shared-runner.mjs");
    await writeFile(fakeRunnerPath, "console.log('shared worker finished without an output ref');\n", "utf8");

    const result = await runWorker(graphPath, {
      session: "codex-shared-finalization",
      once: true,
      cwd: dir,
      stream: false,
      codexCommand: process.execPath,
      codexArgs: [fakeRunnerPath]
    });

    assert.equal(result.results[0].nodeId, "A");
    assert.equal(result.results[0].status, "failed");
    assert.equal(result.results[0].code, 1);

    const updated = await readGraph(graphPath);
    const node = updated.graph.nodes.A;
    assert.equal(node.status, "failed");
    assert.equal(node.lease, undefined);
    assert.match(node.failureReason, /Cannot complete isolated\/composed node without outputRef\.name: A/);
    assert.match(node.report, /^reports\/A-run_/);

    const report = await readFile(join(dir, node.report), "utf8");
    assert.match(report, /shared worker finished without an output ref/);
  });
});

test("git-isolated worker prepares a per-run clone cwd before running Codex", async () => {
  await withLocalBareRemote(async ({ dir, remotePath }) => {
    const graphDir = join(dir, "graph");
    const graphPath = join(graphDir, "plan.graph.json");
    const fakeRunnerPath = join(dir, "fake-clone-cwd-runner.mjs");
    await mkdir(graphDir);

    const graph = fixtureGraph();
    graph.scheduler.remote = remotePath;
    graph.graph.nodes = {
      ROOT: { title: "Root", kind: "parallel", status: "pending", children: ["A", "B"] },
      A: { title: "Clone A", kind: "task", status: "pending" },
      B: { title: "Clone B", kind: "task", status: "pending" }
    };
    await writeFile(graphPath, `${JSON.stringify(graph, null, 2)}\n`, "utf8");
    await writeFile(
      fakeRunnerPath,
      [
        "const prompt = process.argv.at(-1);",
        "const workspace = prompt.match(/Workspace:\\n([^\\n]+)/)?.[1] || '';",
        "console.log(`cwd=${process.cwd()}`);",
        "console.log(`prompt-workspace=${workspace}`);"
      ].join("\n"),
      "utf8"
    );

    const result = await runWorker(graphPath, {
      session: "iso-clone",
      once: true,
      isolation: "git",
      cwd: join(dir, "shared-cwd"),
      stream: false,
      codexCommand: process.execPath,
      codexArgs: [fakeRunnerPath]
    });

    assert.equal(result.idle, false);
    assert.equal(result.results[0].nodeId, "A");
    assert.equal(result.results[0].status, "done");

    const secondResult = await runWorker(graphPath, {
      session: "iso-clone",
      nodeId: "B",
      once: true,
      isolation: "git",
      cwd: join(dir, "shared-cwd"),
      stream: false,
      codexCommand: process.execPath,
      codexArgs: [fakeRunnerPath]
    });
    assert.equal(secondResult.idle, false);
    assert.equal(secondResult.results[0].nodeId, "B");
    assert.equal(secondResult.results[0].status, "done");

    const graphAfter = await readGraph(graphPath);
    const node = graphAfter.graph.nodes.A;
    const secondNode = graphAfter.graph.nodes.B;
    assert.equal(dirname(node.workspace.cloneCwd), join(graphDir, "runs", "workspaces", "iso-clone", "A"));
    assert.equal(dirname(secondNode.workspace.cloneCwd), join(graphDir, "runs", "workspaces", "iso-clone", "B"));
    assert.notEqual(node.workspace.cloneCwd, secondNode.workspace.cloneCwd);
    assert.equal(existsSync(join(node.workspace.cloneCwd, ".git")), true);
    assert.equal(existsSync(join(secondNode.workspace.cloneCwd, ".git")), true);
    assert.equal(node.history.filter((entry) => entry.event === "clone-prepared").length, 1);
    assert.equal(secondNode.history.filter((entry) => entry.event === "clone-prepared").length, 1);

    const report = await readFile(join(graphDir, node.report), "utf8");
    assert.match(report, new RegExp(`- Worker cwd: ${escapeRegExp(node.workspace.cloneCwd)}`));
    assert.match(report, new RegExp(`cwd=${escapeRegExp(await realpath(node.workspace.cloneCwd))}`));
    assert.match(report, new RegExp(`prompt-workspace=${escapeRegExp(node.workspace.cloneCwd)}`));
  });
});

test("git-isolated one-shot worker runs in a clone and records an output ref", async () => {
  await withLocalBareRemote(async ({ dir, remotePath }) => {
    const graphDir = join(dir, "graph");
    const graphPath = join(graphDir, "plan.graph.json");
    const fakeRunnerPath = join(dir, "fake-isolated-runner.mjs");
    await mkdir(graphDir);
    await writeWorkerIsolationGraph(graphPath, remotePath);
    await writeCommittingWorkerRunner(fakeRunnerPath);

    const result = await runWorker(graphPath, {
      session: "iso-one",
      once: true,
      isolation: "git",
      stream: false,
      codexCommand: process.execPath,
      codexArgs: [fakeRunnerPath]
    });

    assert.equal(result.idle, false);
    assert.equal(result.results[0].nodeId, "A");
    assert.equal(result.results[0].status, "done");
    assert.equal(existsSync(join(graphDir, "worker-output-A.txt")), false);
    assert.equal(existsSync(join(graphDir, "shared-name.txt")), false);

    const graph = await readGraph(graphPath);
    const node = graph.graph.nodes.A;
    assert.equal(node.status, "done");
    assert.match(node.workspace.cloneCwd, /runs\/workspaces\/iso-one\/A\/run_/);
    assert.match(node.workRef.name, /^refs\/heads\/spg\/node\/A\/run_/);
    assert.equal(node.outputRef.name, node.workRef.name);
    assert.match(node.outputRef.commit, /^[0-9a-f]{40}$/);
    assert.equal(node.gitFootprint.baseRef.name, node.baseRef.name);
    assert.equal(node.gitFootprint.headRef.name, node.outputRef.name);
    assert.equal(node.gitFootprint.diffStat.filesChanged, 2);
    assert.deepEqual(node.gitFootprint.files.map((file) => file.path).sort(), ["shared-name.txt", "worker-output-A.txt"]);
    assert.equal(node.outputRef.diffStat, undefined);

    const report = await readFile(join(graphDir, node.report), "utf8");
    assert.match(report, /## Isolation/);
    assert.match(report, new RegExp(`- Worker cwd: ${node.workspace.cloneCwd.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    assert.match(report, new RegExp(`- Clone cwd: ${node.workspace.cloneCwd.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    assert.match(report, new RegExp(`- Work branch/ref: ${node.workRef.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    assert.match(report, new RegExp(`- Output ref: ${node.outputRef.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    assert.match(report, /- Files changed: 2/);
    assert.match(report, /- Changed paths: shared-name\.txt, worker-output-A\.txt/);

    const output = await gitShow(node.workspace.bareRepo, node.outputRef.name, "worker-output-A.txt");
    assert.match(output, /node=A/);
    assert.match(output, new RegExp(`cwd=${(await realpath(node.workspace.cloneCwd)).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  });
});

test("git-isolated worker treats diffstat collection failure as a warning", async () => {
  await withLocalBareRemote(async ({ dir, remotePath }) => {
    const graphDir = join(dir, "graph");
    const graphPath = join(graphDir, "plan.graph.json");
    const fakeRunnerPath = join(dir, "fake-isolated-runner.mjs");
    const fakeGitPath = join(dir, "fake-bin", "git");
    await mkdir(graphDir);
    await mkdir(dirname(fakeGitPath), { recursive: true });
    await writeWorkerIsolationGraph(graphPath, remotePath);
    await writeCommittingWorkerRunner(fakeRunnerPath);
    await writeDiffstatFailingGitWrapper(fakeGitPath);

    const originalPath = process.env.PATH;
    process.env.PATH = `${dirname(fakeGitPath)}:${originalPath}`;
    let result;
    try {
      result = await runWorker(graphPath, {
        session: "iso-diffstat-warning",
        once: true,
        isolation: "git",
        stream: false,
        codexCommand: process.execPath,
        codexArgs: [fakeRunnerPath]
      });
    } finally {
      process.env.PATH = originalPath;
    }

    assert.equal(result.results[0].status, "done");
    assert.equal(result.results[0].code, 0);
    const graph = await readGraph(graphPath);
    const node = graph.graph.nodes.A;
    assert.equal(node.status, "done");
    assert.equal(node.outputRef.name, node.workRef.name);
    assert.match(node.outputRef.commit, /^[0-9a-f]{40}$/);
    assert.equal(node.outputRef.diffStat, undefined);
    assert.match(node.gitFootprintWarning, /Git diffstat collection failed: .*forced diffstat failure/);
    assert.match(await gitShow(node.workspace.bareRepo, node.outputRef.name, "worker-output-A.txt"), /node=A/);

    const report = await readFile(join(graphDir, node.report), "utf8");
    assert.match(report, /- Exit code: 0/);
    assert.match(report, /- Git footprint warning: .*forced diffstat failure/);
    assert.doesNotMatch(report, /worker output publication failed/);
  });
});

test("concurrent git-isolated workers use distinct clones, branches, and output refs", async () => {
  await withLocalBareRemote(async ({ dir, remotePath }) => {
    const graphDir = join(dir, "graph");
    const graphPath = join(graphDir, "plan.graph.json");
    const fakeRunnerPath = join(dir, "fake-concurrent-isolated-runner.mjs");
    await mkdir(graphDir);
    await writeWorkerIsolationGraph(graphPath, remotePath, parallelWorkerIsolationGraph(remotePath));
    await writeCommittingWorkerRunner(fakeRunnerPath);

    const results = await Promise.all([
      runWorker(graphPath, {
        session: "iso-concurrent-A",
        once: true,
        isolation: "git",
        stream: false,
        codexCommand: process.execPath,
        codexArgs: [fakeRunnerPath]
      }),
      runWorker(graphPath, {
        session: "iso-concurrent-B",
        once: true,
        isolation: "git",
        stream: false,
        codexCommand: process.execPath,
        codexArgs: [fakeRunnerPath]
      })
    ]);

    assert.deepEqual(results.flatMap((result) => result.results.map((workerResult) => workerResult.nodeId)).sort(), ["A", "B"]);
    const graph = await readGraph(graphPath);
    const left = graph.graph.nodes.A;
    const right = graph.graph.nodes.B;
    assert.equal(left.status, "done");
    assert.equal(right.status, "done");
    assert.notEqual(left.workspace.cloneCwd, right.workspace.cloneCwd);
    assert.notEqual(left.workRef.name, right.workRef.name);
    assert.notEqual(left.outputRef.name, right.outputRef.name);
    assert.match(left.workspace.cloneCwd, /runs\/workspaces\/iso-concurrent-/);
    assert.match(right.workspace.cloneCwd, /runs\/workspaces\/iso-concurrent-/);

    const leftReport = await readFile(join(graphDir, left.report), "utf8");
    const rightReport = await readFile(join(graphDir, right.report), "utf8");
    assert.match(leftReport, new RegExp(`- Clone cwd: ${left.workspace.cloneCwd.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    assert.match(leftReport, new RegExp(`- Work branch/ref: ${left.workRef.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    assert.match(rightReport, new RegExp(`- Clone cwd: ${right.workspace.cloneCwd.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    assert.match(rightReport, new RegExp(`- Work branch/ref: ${right.workRef.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));

    assert.equal(await gitShow(left.workspace.bareRepo, left.outputRef.name, "shared-name.txt"), "A\n");
    assert.equal(await gitShow(right.workspace.bareRepo, right.outputRef.name, "shared-name.txt"), "B\n");
    assert.match(await gitShow(left.workspace.bareRepo, left.outputRef.name, "worker-output-A.txt"), /node=A/);
    assert.match(await gitShow(right.workspace.bareRepo, right.outputRef.name, "worker-output-B.txt"), /node=B/);
    await assert.rejects(() => gitShow(left.workspace.bareRepo, left.outputRef.name, "worker-output-B.txt"));
    await assert.rejects(() => gitShow(right.workspace.bareRepo, right.outputRef.name, "worker-output-A.txt"));
    assert.equal(existsSync(join(graphDir, "shared-name.txt")), false);
  });
});

test("git-isolated worker auto-commits dirty successful workspace before publishing", async () => {
  await withLocalBareRemote(async ({ dir, remotePath }) => {
    const graphDir = join(dir, "graph");
    const graphPath = join(graphDir, "plan.graph.json");
    const fakeRunnerPath = join(dir, "fake-dirty-isolated-runner.mjs");
    await mkdir(graphDir);
    await writeWorkerIsolationGraph(graphPath, remotePath);
    await writeFile(
      fakeRunnerPath,
      [
        "import { mkdirSync, writeFileSync } from 'node:fs';",
        "const prompt = process.argv.at(-1) || '';",
        "const nodeId = prompt.match(/^- Node: (.+)$/m)?.[1] || 'unknown';",
        "const runId = prompt.match(/^- Run: (.+)$/m)?.[1] || 'unknown';",
        "mkdirSync('docs', { recursive: true });",
        "writeFileSync(`worker-output-${nodeId}.txt`, `node=${nodeId}\nrun=${runId}\n`);",
        "writeFileSync('docs/uncommitted.md', `# ${nodeId}\n`);",
        "console.log(`dirty node=${nodeId}`);"
      ].join("\n"),
      "utf8"
    );

    const result = await runWorker(graphPath, {
      session: "iso-dirty",
      once: true,
      isolation: "git",
      stream: false,
      codexCommand: process.execPath,
      codexArgs: [fakeRunnerPath]
    });

    assert.equal(result.results[0].status, "done");
    const graph = await readGraph(graphPath);
    const node = graph.graph.nodes.A;
    assert.equal(node.status, "done");
    assert.equal(node.outputRef.name, node.workRef.name);
    assert.equal(node.outputRef.noOp, false);
    assert.equal(node.outputRef.source, "worker-commit");
    assert.equal(node.outputRef.autoCommitted, true);
    assert.notEqual(node.outputRef.commit, node.baseRef.commit);

    assert.match(await gitShow(node.workspace.bareRepo, node.outputRef.name, "worker-output-A.txt"), /node=A/);
    assert.equal(await gitShow(node.workspace.bareRepo, node.outputRef.name, "docs/uncommitted.md"), "# A\n");

    const status = await execFileAsync("git", ["status", "--porcelain=v1"], { cwd: node.workspace.cloneCwd });
    assert.equal(status.stdout, "");

    const report = await readFile(join(graphDir, node.report), "utf8");
    assert.match(report, /- Auto-committed workspace changes: true/);
    assert.doesNotMatch(report, /- No-op output: true/);
  });
});

test("git-isolated no-op worker still publishes the run output ref at the base commit", async () => {
  await withLocalBareRemote(async ({ dir, remotePath }) => {
    const graphDir = join(dir, "graph");
    const graphPath = join(graphDir, "plan.graph.json");
    const fakeRunnerPath = join(dir, "fake-noop-isolated-runner.mjs");
    await mkdir(graphDir);
    await writeWorkerIsolationGraph(graphPath, remotePath);
    await writeNoopWorkerRunner(fakeRunnerPath);

    const result = await runWorker(graphPath, {
      session: "iso-noop",
      once: true,
      isolation: "git",
      stream: false,
      codexCommand: process.execPath,
      codexArgs: [fakeRunnerPath]
    });

    assert.equal(result.results[0].status, "done");
    const graph = await readGraph(graphPath);
    const node = graph.graph.nodes.A;
    assert.match(node.workspace.cloneCwd, /runs\/workspaces\/iso-noop\/A\/run_/);
    assert.match(node.baseRef.commit, /^[0-9a-f]{40}$/);
    assert.equal(node.workRef.commit, node.baseRef.commit);
    assert.equal(node.outputRef.commit, node.baseRef.commit);
    assert.equal(node.outputRef.name, node.workRef.name);
    assert.equal(node.outputRef.noOp, true);

    const diff = await execFileAsync("git", [
      "--git-dir",
      node.workspace.bareRepo,
      "diff",
      "--name-only",
      `${node.baseRef.commit}..${node.outputRef.name}`
    ]);
    assert.equal(diff.stdout, "");

    const report = await readFile(join(graphDir, node.report), "utf8");
    assert.match(report, /noop cwd=/);
    assert.match(report, new RegExp(`- Output ref: ${node.outputRef.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    assert.match(report, /- No-op output: true/);
  });
});

test("worker records child process spawn errors as failed reports", async () => {
  await withTempGraph(async (graphPath, dir) => {
    const result = await runWorker(graphPath, {
      session: "codex-spawn-error",
      once: true,
      cwd: dir,
      stream: false,
      codexCommand: join(dir, "missing-runner"),
      codexArgs: []
    });

    assert.equal(result.results[0].status, "failed");
    assert.equal(result.results[0].code, 1);

    const graph = await readGraph(graphPath);
    assert.equal(graph.graph.nodes.A.status, "failed");
    assert.match(graph.graph.nodes.A.failureReason, /codex process error:/);
    assert.match(graph.graph.nodes.A.report, /^reports\/A-run_/);

    const report = await readFile(join(dir, graph.graph.nodes.A.report), "utf8");
    assert.match(report, /## Error/);
    assert.match(report, /missing-runner/);
  });
});

test("worker records non-zero child exits and redacts secrets from reports", async () => {
  await withTempGraph(async (graphPath, dir) => {
    const fakeRunnerPath = join(dir, "fake-failing-runner.mjs");
    await writeFile(
      fakeRunnerPath,
      "console.log('SLACK_WEBHOOK_URL=https://hooks.slack.com/services/T000/B000/SECRET'); console.error('token=super-secret'); process.exit(7);\n",
      "utf8"
    );

    const result = await runWorker(graphPath, {
      session: "codex-nonzero",
      once: true,
      cwd: dir,
      stream: false,
      codexCommand: process.execPath,
      codexArgs: [fakeRunnerPath]
    });

    assert.equal(result.results[0].status, "failed");
    assert.equal(result.results[0].code, 7);

    const graph = await readGraph(graphPath);
    assert.equal(graph.graph.nodes.A.status, "failed");
    assert.equal(graph.graph.nodes.A.failureReason, "codex exited with 7");

    const report = await readFile(join(dir, graph.graph.nodes.A.report), "utf8");
    assert.match(report, /- Exit code: 7/);
    assert.match(report, /SLACK_WEBHOOK_URL=\[REDACTED\]/);
    assert.match(report, /token=\[REDACTED\]/);
    assert.doesNotMatch(report, /super-secret|T000\/B000\/SECRET/);
  });
});

test("runCodexPrompt treats command strings as executable paths without shell expansion", async () => {
  await withTempGraph(async (_graphPath, dir) => {
    const markerPath = join(dir, "shell-expanded-marker");
    const result = await runCodexPrompt("prompt", {
      cwd: dir,
      stream: false,
      codexCommand: `${process.execPath}; touch ${markerPath}`,
      codexArgs: []
    });

    assert.equal(result.code, 1);
    assert.match(result.error, /ENOENT|spawn/);
    assert.equal(existsSync(markerPath), false);
  });
});

test("worker validates malformed process fields before claiming work", async () => {
  await withTempGraph(async (graphPath) => {
    const cases = [
      {
        options: { codexCommand: "" },
        pattern: /Invalid codexCommand: expected non-empty string/
      },
      {
        options: { codexCommand: `bad\0command` },
        pattern: /Invalid codexCommand: null bytes are not allowed/
      },
      {
        options: { codexArgs: "--model=gpt-5" },
        pattern: /Invalid codexArgs: expected string array/
      },
      {
        options: { codexArgs: Array.from({ length: 65 }, () => "arg") },
        pattern: /Invalid codexArgs: expected at most 64 entries/
      },
      {
        options: { codexArgs: ["x".repeat(4097)] },
        pattern: /Invalid codexArgs\[0\]: expected string length <= 4096/
      },
      {
        options: { codexArgs: [false] },
        pattern: /Invalid codexArgs\[0\]: expected string/
      },
      {
        options: { cwd: "x".repeat(4097) },
        pattern: /Invalid cwd: expected string length <= 4096/
      }
    ];

    for (const [index, item] of cases.entries()) {
      await assert.rejects(
        runWorker(graphPath, {
          session: `codex-invalid-${index}`,
          once: true,
          stream: false,
          ...item.options
        }),
        item.pattern
      );

      const graph = await readGraph(graphPath);
      assert.equal(graph.graph.nodes.A.status, "pending");
      assert.equal(graph.graph.nodes.A.lease, undefined);
      assert.equal(graph.graph.nodes.A.history, undefined);
    }
  });
});

test("runCodexPrompt records signal termination", async () => {
  await withTempGraph(async (_graphPath, dir) => {
    const fakeRunnerPath = join(dir, "fake-signal-runner.mjs");
    await writeFile(fakeRunnerPath, "process.kill(process.pid, 'SIGTERM'); setTimeout(() => {}, 1000);\n", "utf8");

    const result = await runCodexPrompt("prompt", {
      cwd: dir,
      stream: false,
      codexCommand: process.execPath,
      codexArgs: [fakeRunnerPath]
    });

    assert.equal(result.code, 1);
    assert.equal(result.signal, "SIGTERM");
  });
});

test("worker timeout cancels child and does not mark interrupted work done", async () => {
  await withTempGraph(async (graphPath, dir) => {
    const fakeRunnerPath = join(dir, "fake-timeout-runner.mjs");
    await writeFile(fakeRunnerPath, "setInterval(() => {}, 1000);\n", "utf8");

    const result = await runWorker(graphPath, {
      session: "codex-timeout",
      once: true,
      cwd: dir,
      stream: false,
      timeoutMs: 50,
      codexCommand: process.execPath,
      codexArgs: [fakeRunnerPath]
    });

    assert.equal(result.results[0].status, "failed");
    assert.equal(result.results[0].code, 1);
    assert.equal(result.results[0].signal, "SIGTERM");

    const graph = await readGraph(graphPath);
    assert.equal(graph.graph.nodes.A.status, "failed");
    assert.match(graph.graph.nodes.A.failureReason, /codex timed out after 50ms/);
    assert.notEqual(graph.graph.nodes.A.status, "done");

    const report = await readFile(join(dir, graph.graph.nodes.A.report), "utf8");
    assert.match(report, /- Timed out: true/);
    assert.match(report, /- Timeout ms: 50/);
  });
});

test("lease heartbeat reports renewal failure and can be stopped", async () => {
  const claim = {
    nodeId: "A",
    title: "Bootstrap",
    runId: "run-heartbeat",
    lease: {
      session: "codex-heartbeat",
      runId: "run-heartbeat",
      claimedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 750).toISOString()
    },
    releasedExpired: [],
    summary: { totalNodes: 1, root: "A", counts: { claimed: 1 } }
  };
  let renewals = 0;
  let failure;
  const heartbeat = startLeaseHeartbeat("/tmp/graph.json", {
    claim,
    session: "codex-heartbeat",
    onFailure: (error) => {
      failure = error;
    }
  }, {
    renewNodeLease: async () => {
      renewals += 1;
      throw new Error("lease store unavailable");
    }
  });

  await waitFor(() => failure, 1000);
  heartbeat.stop();
  const renewalsAfterStop = renewals;
  await new Promise((resolveWait) => setTimeout(resolveWait, 350));

  assert.equal(failure.message, "lease store unavailable");
  assert.equal(renewals, renewalsAfterStop);
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

async function createFixtureBranch({
  sourcePath,
  remotePath,
  branchName,
  baseRef = "main",
  textFiles = {},
  binaryFiles = {},
  message
}) {
  await execFileAsync("git", ["checkout", "-B", branchName, baseRef], { cwd: sourcePath });
  for (const [filePath, contents] of Object.entries(textFiles)) {
    const fileDir = dirname(filePath);
    if (fileDir !== ".") {
      await mkdir(join(sourcePath, fileDir), { recursive: true });
    }
    await writeFile(join(sourcePath, filePath), contents, "utf8");
  }
  for (const [filePath, contents] of Object.entries(binaryFiles)) {
    const fileDir = dirname(filePath);
    if (fileDir !== ".") {
      await mkdir(join(sourcePath, fileDir), { recursive: true });
    }
    await writeFile(join(sourcePath, filePath), contents);
  }
  await execFileAsync("git", ["add", "-A"], { cwd: sourcePath });
  await execFileAsync("git", ["commit", "-m", message], { cwd: sourcePath });
  await execFileAsync("git", ["push", remotePath, `${branchName}:refs/heads/${branchName}`], { cwd: sourcePath });
  const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: sourcePath });
  await execFileAsync("git", ["checkout", "main"], { cwd: sourcePath });
  return {
    name: `refs/heads/${branchName}`,
    commit: stdout.trim()
  };
}

async function writeDiffstatFailingGitWrapper(wrapperPath) {
  const { stdout } = await execFileAsync("which", ["git"]);
  const realGit = stdout.trim();
  await writeFile(
    wrapperPath,
    [
      "#!/usr/bin/env node",
      "import { spawnSync } from 'node:child_process';",
      `const realGit = ${JSON.stringify(realGit)};`,
      "const args = process.argv.slice(2);",
      "if (args.includes('diff') && (args.includes('--numstat') || args.includes('--name-status'))) {",
      "  console.error('forced diffstat failure');",
      "  process.exit(42);",
      "}",
      "const result = spawnSync(realGit, args, { encoding: 'utf8' });",
      "if (result.stdout) process.stdout.write(result.stdout);",
      "if (result.stderr) process.stderr.write(result.stderr);",
      "if (result.error) {",
      "  console.error(result.error.message);",
      "  process.exit(127);",
      "}",
      "process.exit(result.status ?? 1);"
    ].join("\n"),
    "utf8"
  );
  await execFileAsync("chmod", ["755", wrapperPath]);
}
