import test from "node:test";
import { assert, assertGeneratedGraphReachableAndAcyclic, assertGeneratedPathSpecificFailure, assertGeneratedTraversalSafe, assertReadableGraphValidationOutput, blockNode, buildPlanGraphJsonSchema, buildReachableDepthMap, buildReachableParentMap, buildStableRootPathMap, captureSchedulerCli, claimNode, copyGraphFixtureToTemp, createGeneratedMalformedVariant, defaultReportPath, diagnoseGraph, dirname, escapeRegExp, execFileAsync, exportOperationalEvents, fixtureGraph, generateSeededTopologyGraph, generatedWarningVariant, graphFixturePath, graphFixturesDir, graphSchemaPath, graphValidationCases, graphValidatorOutcomes, installGraphIoFaultInjectorForTests, invalidGraphValidatorOutcomes, join, lastHistory, lockArtifacts, mkdir, mkdtemp, operationalEventTaxonomy, operationalEvents, readFile, readGraph, readdir, redactOperationalEventDetails, rendererScriptPath, rm, schedulerScriptPath, sleep, summarizeGraph, symlink, tmpdir, utimes, validGraphValidatorOutcomes, validatePlanGraphFileResult, validateThenTraverseGraph, withGraphLock, withTempGraph, writeFile, writeGraphAtomic, writeReportFile } from "./helpers/plan-scheduler-harness.mjs";

test("graph summary includes plan metadata", () => {
  const summary = summarizeGraph(fixtureGraph());
  assert.equal(summary.title, "Fixture Implementation Plan");
  assert.equal(summary.description, "Coordinate fixture work across a series root, parallel branches, and a final gate.");
});

test("reachable ancestry helpers derive parents, depths, and stable root paths without mutating the graph", () => {
  const graph = {
    graphVersion: 1,
    title: "Reachability helper plan",
    graph: {
      root: "ROOT",
      nodes: {
        ROOT: { title: "Root", kind: "parallel", status: "pending", children: ["B", "UNKNOWN", "A"] },
        A: { title: "A", kind: "series", status: "pending", children: ["DIRECT", "DEEP"] },
        B: { title: "B", kind: "parallel", status: "pending", children: ["B1", "SHARED", "DIRECT"] },
        UNKNOWN: { title: "Unknown wrapper", kind: "custom-wrapper", status: "custom", children: ["U1"] },
        DIRECT: { title: "Direct shared", kind: "task", status: "pending" },
        DEEP: { title: "Deep wrapper", kind: "series", status: "pending", children: ["SHARED"] },
        SHARED: { title: "Shared leaf", kind: "gate", status: "pending" },
        B1: { title: "B child", kind: "task", status: "pending" },
        U1: { title: "Unknown child", kind: "task", status: "pending" },
        ORPHAN: { title: "Orphan", kind: "task", status: "pending" }
      }
    }
  };
  const before = structuredClone(graph);

  assert.deepEqual(buildReachableParentMap(graph), {
    ROOT: [],
    A: ["ROOT"],
    B: ["ROOT"],
    UNKNOWN: ["ROOT"],
    DIRECT: ["A", "B"],
    DEEP: ["A"],
    SHARED: ["B", "DEEP"],
    B1: ["B"],
    U1: ["UNKNOWN"]
  });
  assert.deepEqual(buildReachableDepthMap(graph), {
    ROOT: 0,
    A: 1,
    B: 1,
    UNKNOWN: 1,
    DIRECT: 2,
    DEEP: 2,
    SHARED: 2,
    B1: 2,
    U1: 2
  });
  assert.deepEqual(buildStableRootPathMap(graph), {
    ROOT: ["ROOT"],
    A: ["ROOT", "A"],
    B: ["ROOT", "B"],
    UNKNOWN: ["ROOT", "UNKNOWN"],
    DIRECT: ["ROOT", "A", "DIRECT"],
    DEEP: ["ROOT", "A", "DEEP"],
    SHARED: ["ROOT", "B", "SHARED"],
    B1: ["ROOT", "B", "B1"],
    U1: ["ROOT", "UNKNOWN", "U1"]
  });
  assert.deepEqual(graph, before);
});

test("reachable ancestry helpers reject cycles defensively", () => {
  const graph = {
    graph: {
      root: "ROOT",
      nodes: {
        ROOT: { title: "Root", kind: "series", status: "pending", children: ["A"] },
        A: { title: "Cycle", kind: "series", status: "pending", children: ["ROOT"] }
      }
    }
  };

  assert.throws(() => buildReachableDepthMap(graph), /Cycle detected in graph: ROOT -> A -> ROOT/);
});

test("graph diagnostics expose ready, lease, blocked, failed, and lock state", async () => {
  await withTempGraph(async (graphPath, dir) => {
    const graph = {
      graphVersion: 7,
      title: "Diagnostics Plan",
      graph: {
        root: "ROOT",
        nodes: {
          ROOT: { title: "Root", kind: "parallel", status: "pending", children: ["READY", "ACTIVE", "EXPIRED", "BLOCKED", "FAILED", "DONE_MISSING", "BUFFER"] },
          READY: { title: "Ready work", kind: "task", status: "pending" },
          ACTIVE: {
            title: "Active lease",
            kind: "task",
            status: "running",
            lease: {
              session: "codex-active",
              runId: "run-active",
              claimedAt: "2026-05-27T00:00:00.000Z",
              expiresAt: "2999-01-01T00:00:00.000Z",
              cloneCwd: "/tmp/spg/workspaces/codex-active/ACTIVE/run-active"
            },
            baseRef: { name: "refs/remotes/origin/main" },
            workRef: { name: "refs/heads/spg/node/ACTIVE/run-active" },
            history: [
              {
                at: "2026-05-27T00:00:02.000Z",
                event: "clone-prepared",
                remote: "https://example.invalid/repo.git",
                bareRepo: "/tmp/spg/git/cache/repo.git",
                cloneCwd: "/tmp/spg/workspaces/codex-active/ACTIVE/run-active",
                baseRef: "refs/remotes/origin/main"
              }
            ]
          },
          EXPIRED: {
            title: "Expired lease",
            kind: "task",
            status: "claimed",
            lease: {
              session: "codex-expired",
              runId: "run-expired",
              claimedAt: "2026-05-27T00:00:00.000Z",
              expiresAt: "2026-05-27T00:00:01.000Z"
            }
          },
          BLOCKED: {
            title: "Blocked work",
            kind: "task",
            status: "blocked",
            blockedReason: "needs_scope",
            question: "Which scope?",
            lease: {
              session: "codex-blocked",
              runId: "run-blocked",
              claimedAt: "2026-05-27T00:00:00.000Z",
              expiresAt: "2026-05-27T00:00:01.000Z"
            }
          },
          FAILED: {
            title: "Failed work",
            kind: "task",
            status: "failed",
            failureReason: "tests failed",
            report: "reports/failed.md"
          },
          DONE_MISSING: {
            title: "Missing output",
            kind: "task",
            status: "done",
            baseRef: { name: "refs/remotes/origin/main" },
            workRef: { name: "refs/heads/spg/node/DONE_MISSING/run-missing" }
          },
          BUFFER: {
            title: "Conflicted buffer",
            kind: "parallel",
            status: "done",
            children: ["LEFT", "RIGHT"],
            integrationRef: {
              name: "refs/heads/spg/integration/BUFFER/run-buffer",
              kind: "parallel",
              status: "conflicted",
              inputRefs: [{ nodeId: "LEFT", outputRef: "refs/heads/spg/node/LEFT/run-left" }]
            },
            history: [
              {
                at: "2026-05-27T00:00:03.000Z",
                event: "merge-conflicted",
                parentId: "BUFFER",
                integrationRef: "refs/heads/spg/integration/BUFFER/run-buffer",
                childId: "LEFT",
                childOutputRef: "refs/heads/spg/node/LEFT/run-left"
              }
            ]
          },
          LEFT: {
            title: "Left merged child",
            kind: "task",
            status: "done",
            outputRef: { name: "refs/heads/spg/node/LEFT/run-left" }
          },
          RIGHT: {
            title: "Right merged child",
            kind: "task",
            status: "done",
            outputRef: { name: "refs/heads/spg/node/RIGHT/run-right" }
          }
        }
      }
    };
    await writeFile(graphPath, `${JSON.stringify(graph, null, 2)}\n`, "utf8");

    const lockPath = `${graphPath}.lock`;
    await mkdir(lockPath);
    await writeFile(join(lockPath, "metadata.json"), `${JSON.stringify({
      lockVersion: 1,
      ownerId: "diagnostic-owner",
      pid: 24680,
      host: "diagnostic-host",
      createdAt: "2026-05-27T01:00:00.000Z",
      updatedAt: "2026-05-27T01:00:01.000Z",
      graphPath
    }, null, 2)}\n`, "utf8");
    const oldTime = new Date(Date.now() - 20 * 60_000);
    await utimes(lockPath, oldTime, oldTime);

    const diagnostics = await diagnoseGraph(graphPath);
    assert.equal(diagnostics.graphPath, graphPath);
    assert.deepEqual(diagnostics.nextReady.map((node) => node.id), ["READY"]);
    assert.deepEqual(diagnostics.leases.active.map((node) => node.id), ["ACTIVE"]);
    assert.deepEqual(diagnostics.isolation.activeWorkers.map((node) => node.id), ["ACTIVE"]);
    assert.equal(diagnostics.isolation.activeWorkers[0].isolation.cloneCwd, "/tmp/spg/workspaces/codex-active/ACTIVE/run-active");
    assert.equal(diagnostics.isolation.activeWorkers[0].isolation.workRef, "refs/heads/spg/node/ACTIVE/run-active");
    assert.deepEqual(diagnostics.leases.expired.map((node) => node.id), ["BLOCKED", "EXPIRED"]);
    assert.deepEqual(diagnostics.leases.expired.map((node) => node.releasable), [false, true]);
    assert.deepEqual(diagnostics.blocked.map((node) => node.id), ["BLOCKED"]);
    assert.equal(diagnostics.blocked[0].blockedReason, "needs_scope");
    assert.deepEqual(diagnostics.failed.map((node) => node.id), ["FAILED"]);
    assert.equal(diagnostics.failed[0].failureReason, "tests failed");
    assert.deepEqual(diagnostics.isolation.missingOutputRefs.map((node) => node.id), ["BUFFER", "DONE_MISSING"]);
    assert.deepEqual(diagnostics.isolation.unresolvedBufferConflicts.map((node) => node.id), ["BUFFER"]);
    assert.equal(diagnostics.isolation.unresolvedBufferConflicts[0].isolation.conflictedMergeRefs[0].outputRef, "refs/heads/spg/node/LEFT/run-left");
    assert.equal(diagnostics.lock.exists, true);
    assert.equal(diagnostics.lock.stale, true);
    assert.equal(diagnostics.lock.owner.pid, 24680);
    assert.ok(diagnostics.actions.some((action) => action.includes("release-expired")));
    assert.ok(diagnostics.actions.some((action) => action.includes("blocked")));
    assert.ok(diagnostics.actions.some((action) => action.includes("failed")));
    assert.ok(diagnostics.actions.some((action) => action.includes("active isolated worker")));
    assert.ok(diagnostics.actions.some((action) => action.includes("missing output refs")));
    assert.ok(diagnostics.actions.some((action) => action.includes("unresolved composition buffer")));
    assert.ok(diagnostics.actions.some((action) => action.includes("ready leaf")));
    assert.deepEqual(await lockArtifacts(dir), ["plan.graph.json.lock"]);
  });
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

test("graph schema fixtures match curated validator outcomes", async (t) => {
  const fixtureFiles = (await readdir(graphFixturesDir)).filter((entry) => entry.endsWith(".graph.json")).sort();
  assert.deepEqual(
    graphValidatorOutcomes.map((outcome) => outcome.fixture).sort(),
    fixtureFiles,
    "Each graph fixture should have an expected validator outcome"
  );

  for (const outcome of graphValidatorOutcomes) {
    await t.test(outcome.fixture, async () => {
      const graphPath = graphFixturePath(outcome.fixture);
      const content = await readFile(graphPath, "utf8");

      if (outcome.parseError) {
        assert.throws(() => JSON.parse(content), SyntaxError);
        await assert.rejects(
          () => readGraph(graphPath),
          (error) => {
            assert.match(error.message, /Failed to parse graph file/);
            assert.ok(error.message.includes(graphPath));
            return true;
          }
        );
        return;
      }

      const graph = JSON.parse(content);
      const validation = validatePlanGraphFileResult(graph);
      assert.deepEqual(validation.errors, outcome.errors, `${outcome.fixture} errors`);
      assert.deepEqual(validation.warnings, outcome.warnings, `${outcome.fixture} warnings`);

      if (outcome.valid) {
        assert.equal((await readGraph(graphPath)).graph.root, graph.graph.root);
      } else {
        await assert.rejects(
          () => readGraph(graphPath),
          (error) => {
            assert.match(error.message, /Invalid graph file/);
            assert.ok(error.message.includes(graphPath));
            for (const issue of outcome.errors) {
              assert.ok(error.message.includes(issue.path), `missing issue path ${issue.path}`);
              assert.ok(error.message.includes(issue.message), `missing issue message ${issue.message}`);
            }
            return true;
          }
        );
      }
    });
  }
});

test("graph schema fixture coverage includes TEN4 invariant pass and fail cases", () => {
  const coverage = new Set(graphValidatorOutcomes.flatMap((outcome) => outcome.covers || []));
  const fatalInvariants = [
    "graph-object",
    "graph-body",
    "root-string",
    "root-in-nodes",
    "nodes-map",
    "node-object",
    "children-array",
    "child-id-string",
    "child-exists",
    "no-duplicate-child",
    "acyclic",
    "non-empty-series",
    "non-empty-parallel",
    "lease-shape",
    "timestamp-shape",
    "history-shape"
  ];
  const warningInvariants = [
    "unknown-kind",
    "unknown-status",
    "task-with-children",
    "gate-with-children",
    "lease-status-compatibility",
    "unreachable-node"
  ];

  for (const invariant of fatalInvariants) {
    assert.ok(coverage.has(`passes:${invariant}`), `missing passing fixture coverage for ${invariant}`);
    assert.ok(coverage.has(`fails:${invariant}`), `missing failing fixture coverage for ${invariant}`);
  }
  for (const invariant of warningInvariants) {
    assert.ok(coverage.has(`warns:${invariant}`), `missing warning fixture coverage for ${invariant}`);
  }
  assert.ok(coverage.has("passes:missing-kind-default"));
  assert.ok(coverage.has("passes:missing-status-default"));
  assert.ok(coverage.has("fails:json-parse"));
});

test("graph validator fixture matrix distinguishes compatibility warnings from fatal errors", () => {
  const matrixCategories = new Set(graphValidatorOutcomes.map((outcome) => outcome.matrixCategory));
  for (const category of ["minimal", "rich", "legacy-compatible", "warning-only", "invalid"]) {
    assert.ok(matrixCategories.has(category), `missing fixture matrix category ${category}`);
    assert.ok(
      graphValidatorOutcomes.some((outcome) => (outcome.covers || []).includes(`matrix:${category}`)),
      `missing coverage marker for fixture matrix category ${category}`
    );
  }

  const warningOnlyOutcomes = graphValidatorOutcomes.filter((outcome) => outcome.matrixCategory === "warning-only");
  assert.ok(warningOnlyOutcomes.length > 0, "fixture matrix should include warning-only graphs");
  for (const outcome of warningOnlyOutcomes) {
    assert.equal(outcome.valid, true, `${outcome.fixture} should remain loadable`);
    assert.deepEqual(outcome.errors, [], `${outcome.fixture} should not encode warnings as errors`);
    assert.ok(outcome.warnings.length > 0, `${outcome.fixture} should document warning diagnostics`);
  }

  for (const outcome of invalidGraphValidatorOutcomes()) {
    assert.ok(outcome.errors.length > 0, `${outcome.fixture} should document fatal errors`);
    assert.ok(Array.isArray(outcome.warnings), `${outcome.fixture} should document warnings separately`);
  }
});

test("seeded topology generator creates deterministic acyclic reachable graphs that traverse safely", () => {
  assert.deepEqual(generateSeededTopologyGraph(4242), generateSeededTopologyGraph(4242));
  assert.notDeepEqual(generateSeededTopologyGraph(4242), generateSeededTopologyGraph(4243));

  for (let seed = 1; seed <= 64; seed += 1) {
    const graph = generateSeededTopologyGraph(seed);
    const validation = validatePlanGraphFileResult(graph);
    assert.deepEqual(validation, { errors: [], warnings: [] }, `seed ${seed} should validate cleanly`);
    assertGeneratedGraphReachableAndAcyclic(graph);
    assertGeneratedTraversalSafe(graph, `seed ${seed}`);
  }
});

test("generated malformed topology variants fail validation with path-specific errors before traversal", () => {
  const variants = ["missing-child", "cycle", "duplicate-child"];
  for (let seed = 101; seed <= 124; seed += 1) {
    for (const variant of variants) {
      const { graph, expectedPath, expectedMessage } = createGeneratedMalformedVariant(seed, variant);
      assertGeneratedPathSpecificFailure(graph, expectedPath, expectedMessage, `${variant} seed ${seed}`);
    }
  }
});

test("generated unknown kinds and custom statuses warn while remaining traversal-safe", () => {
  const variants = ["unknown-kind", "custom-status"];
  for (let seed = 201; seed <= 224; seed += 1) {
    for (const variant of variants) {
      const { graph, expectedPath, expectedMessage } = generatedWarningVariant(seed, variant);
      const result = validateThenTraverseGraph(graph);
      assert.deepEqual(result.validation.errors, [], `${variant} seed ${seed} should not have validation errors`);
      assert.ok(
        result.validation.warnings.some((issue) => issue.path === expectedPath && issue.message === expectedMessage),
        `${variant} seed ${seed} missing warning ${expectedPath}: ${expectedMessage}`
      );
      assert.equal(result.traversed, true, `${variant} seed ${seed} should traverse despite warning`);
      assertGeneratedTraversalSafe(graph, `${variant} seed ${seed}`);
    }
  }
});

test("graph validation accepts insertion and legacy addition git footprint metadata", () => {
  const graph = {
    graph: {
      root: "ROOT",
      nodes: {
        ROOT: {
          title: "Root",
          kind: "parallel",
          status: "pending",
          children: ["NEW", "LEGACY"]
        },
        NEW: {
          title: "New footprint",
          kind: "task",
          status: "done",
          gitFootprint: {
            diffStat: { filesChanged: 1, insertions: 12, deletions: 3, totalChanges: 15 },
            files: [{ path: "scripts/contracts.ts", insertions: 12, deletions: 3, totalChanges: 15 }]
          }
        },
        LEGACY: {
          title: "Legacy footprint",
          kind: "task",
          status: "done",
          gitFootprint: {
            diffStat: { filesChanged: 1, additions: 12, deletions: 3, totalChanges: 15 },
            files: [{ path: "scripts/contracts.ts", additions: 12, deletions: 3, totalChanges: 15 }]
          }
        }
      }
    }
  };

  assert.deepEqual(validatePlanGraphFileResult(graph).errors, []);
});

test("generated graph JSON Schema artifact is deterministic and maps validator invariants", async () => {
  const checkedInSchema = JSON.parse(await readFile(graphSchemaPath, "utf8"));
  assert.deepEqual(checkedInSchema, buildPlanGraphJsonSchema());

  assert.equal(checkedInSchema.$schema, "https://json-schema.org/draft/2020-12/schema");
  assert.deepEqual(checkedInSchema.required, ["graph"]);
  assert.deepEqual(checkedInSchema.$defs.graphBody.required, ["root", "nodes"]);
  assert.equal(checkedInSchema.$defs.graphBody.properties.root.minLength, 1);
  assert.equal(checkedInSchema.$defs.node.properties.children.uniqueItems, true);
  assert.deepEqual(checkedInSchema.$defs.lease.required, ["session", "runId", "claimedAt", "expiresAt"]);
  assert.deepEqual(checkedInSchema.$defs.historyEntry.required, ["at"]);
  assert.deepEqual(checkedInSchema.$defs.gitDiffStat.anyOf, [
    { required: ["filesChanged", "insertions", "deletions", "totalChanges"] },
    { required: ["filesChanged", "additions", "deletions", "totalChanges"] }
  ]);
  assert.equal(checkedInSchema.$defs.gitDiffStat.properties.filesChanged.type, "number");
  assert.equal(checkedInSchema.$defs.gitDiffStat.properties.insertions.type, "number");
  assert.equal(checkedInSchema.$defs.gitDiffStat.properties.deletions.type, "number");
  assert.deepEqual(checkedInSchema.$defs.gitFileFootprint.anyOf, [
    { required: ["path", "insertions", "deletions", "totalChanges"] },
    { required: ["path", "additions", "deletions", "totalChanges"] }
  ]);
  assert.equal(checkedInSchema.$defs.gitFileFootprint.properties.path.type, "string");
  assert.deepEqual(checkedInSchema.$defs.gitFileFootprint.properties.insertions.type, ["number", "null"]);
  assert.deepEqual(checkedInSchema.$defs.gitFileFootprint.properties.deletions.type, ["number", "null"]);
  assert.equal(
    checkedInSchema.$defs.timestamp.pattern,
    String.raw`^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$`
  );

  for (const kind of ["task", "series", "parallel", "gate"]) {
    assert.ok(checkedInSchema["x-spg-nodeExamples"][kind], `missing schema example for ${kind}`);
  }

  const fatalInvariantEntries = checkedInSchema["x-spg-validatorInvariants"].fatal;
  const fatalInvariantIds = new Set(fatalInvariantEntries.map((entry) => entry.id));
  const fixtureFailureIds = new Set(
    graphValidatorOutcomes.flatMap((outcome) =>
      (outcome.covers || [])
        .filter((cover) => cover.startsWith("fails:"))
        .map((cover) => cover.slice("fails:".length))
    )
  );
  for (const invariant of fixtureFailureIds) {
    assert.ok(fatalInvariantIds.has(invariant), `schema metadata missing fatal invariant ${invariant}`);
  }

  const runtimeOnlyInvariants = new Set(
    fatalInvariantEntries
      .filter((entry) => entry.representableInJsonSchema === false)
      .map((entry) => entry.id)
  );
  for (const invariant of ["json-parse", "root-in-nodes", "child-exists", "acyclic"]) {
    assert.ok(runtimeOnlyInvariants.has(invariant), `missing runtime-only invariant ${invariant}`);
  }

  const releaseChecklist = await readFile(new URL("../docs/release-checklist.md", import.meta.url), "utf8");
  assert.match(releaseChecklist, /npm run schema:graph/);
  assert.match(releaseChecklist, /schemas\//);
});

test("valid graph fixtures remain scheduler-compatible", async (t) => {
  for (const outcome of validGraphValidatorOutcomes()) {
    await t.test(outcome.fixture, async () => {
      const { dir, graphPath } = await copyGraphFixtureToTemp(outcome.fixture);
      try {
        const ready = await execFileAsync(process.execPath, [schedulerScriptPath, "ready", "--graph", graphPath]);
        assert.equal(ready.stderr, "");
        assert.ok(Array.isArray(JSON.parse(ready.stdout)));

        if (outcome.fixture === "valid-basic.graph.json") {
          const outputPath = join(dir, "fixture.html");
          await execFileAsync(process.execPath, [rendererScriptPath, "--graph", graphPath, "--output", outputPath]);
          assert.match(await readFile(outputPath, "utf8"), /Valid Basic Fixture/);
        }
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
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
        lockVersion: 1,
        ownerId: "stale-owner",
        pid: 12345,
        host: "stale-host",
        createdAt: "2026-05-27T01:00:00.000Z",
        updatedAt: "2026-05-27T01:00:00.000Z",
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
    assert.deepEqual(await lockArtifacts(dir), []);
  });
});

test("graph lock writes owner metadata and removes it on release", async () => {
  await withTempGraph(async (graphPath, dir) => {
    const lockPath = `${graphPath}.lock`;

    await withGraphLock(graphPath, async () => {
      const metadata = JSON.parse(await readFile(join(lockPath, "metadata.json"), "utf8"));
      assert.equal(metadata.lockVersion, 1);
      assert.match(metadata.ownerId, /^[0-9a-f-]{36}$/);
      assert.equal(metadata.pid, process.pid);
      assert.equal(typeof metadata.host, "string");
      assert.equal(metadata.graphPath, graphPath);
      assert.match(metadata.createdAt, /^\d{4}-\d{2}-\d{2}T/);
      assert.match(metadata.updatedAt, /^\d{4}-\d{2}-\d{2}T/);
    });

    assert.deepEqual(await lockArtifacts(dir), []);
  });
});

test("graph lock timeout reports lock owner metadata", async () => {
  await withTempGraph(async (graphPath) => {
    const lockPath = `${graphPath}.lock`;
    await mkdir(lockPath);
    await writeFile(
      join(lockPath, "metadata.json"),
      `${JSON.stringify({
        lockVersion: 1,
        ownerId: "timeout-owner",
        pid: 67890,
        createdAt: "2026-05-27T01:23:45.000Z",
        updatedAt: "2026-05-27T01:23:46.000Z",
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
        assert.match(error.message, /updatedAt=2026-05-27T01:23:46\.000Z/);
        assert.match(error.message, /host=test-host/);
        assert.match(error.message, /lockVersion=1/);
        assert.match(error.message, /ownerId=timeout-owner/);
        assert.match(error.message, /timeoutMs=20/);
        assert.match(error.message, /staleMs=60000/);
        assert.match(error.message, new RegExp(escapeRegExp(graphPath)));
        assert.match(error.message, /Next steps: wait for the owner process to finish/);
        assert.match(error.message, /diagnostics --graph/);
        assert.match(error.message, /metadata\.json/);
        return true;
      }
    );
    assert.ok(Date.now() - startedAt < 1000, `Lock timeout for ${lockPath} should stay bounded`);
  });
});

test("graph lock stale reapers cannot overlap critical sections", async () => {
  await withTempGraph(async (graphPath, dir) => {
    const lockPath = `${graphPath}.lock`;
    await mkdir(lockPath);
    await writeFile(
      join(lockPath, "metadata.json"),
      `${JSON.stringify({
        lockVersion: 1,
        ownerId: "old-owner",
        pid: 11111,
        host: "old-host",
        createdAt: "2026-05-27T01:00:00.000Z",
        updatedAt: "2026-05-27T01:00:00.000Z",
        graphPath
      })}\n`,
      "utf8"
    );
    const oldTime = new Date(Date.now() - 60_000);
    await utimes(lockPath, oldTime, oldTime);

    let active = 0;
    let maxActive = 0;
    const attempts = Array.from({ length: 12 }, (_, index) =>
      withGraphLock(
        graphPath,
        async () => {
          active += 1;
          maxActive = Math.max(maxActive, active);
          await sleep(5);
          active -= 1;
          return index;
        },
        { staleMs: 50, retryMs: 1, timeoutMs: 2000, heartbeatMs: 10 }
      )
    );

    const results = await Promise.all(attempts);
    assert.deepEqual(results.sort((left, right) => left - right), Array.from({ length: 12 }, (_, index) => index));
    assert.equal(maxActive, 1);
    assert.deepEqual(await lockArtifacts(dir), []);
  });
});

test("graph lock release does not remove another owner after stale takeover", async () => {
  await withTempGraph(async (graphPath, dir) => {
    const lockPath = `${graphPath}.lock`;
    let releaseReplacement;
    let replacementOwnerId;
    let replacementLock;
    const releaseReplacementSignal = new Promise((resolveRelease) => {
      releaseReplacement = resolveRelease;
    });

    await withGraphLock(
      graphPath,
      async () => {
        const staleTime = new Date(Date.now() - 60_000);
        await utimes(lockPath, staleTime, staleTime);

        const replacementAcquired = new Promise((resolveAcquired, rejectAcquired) => {
          replacementLock = withGraphLock(
            graphPath,
            async () => {
              const metadata = JSON.parse(await readFile(join(lockPath, "metadata.json"), "utf8"));
              replacementOwnerId = metadata.ownerId;
              resolveAcquired();
              await releaseReplacementSignal;
              return "replacement";
            },
            { staleMs: 1, retryMs: 1, timeoutMs: 500, heartbeatMs: 0 }
          ).catch((error) => {
            rejectAcquired(error);
            throw error;
          });
        });

        await replacementAcquired;
      },
      { staleMs: 60_000, retryMs: 1, timeoutMs: 500, heartbeatMs: 0 }
    );

    const metadataWhileReplacementHeld = JSON.parse(await readFile(join(lockPath, "metadata.json"), "utf8"));
    assert.equal(metadataWhileReplacementHeld.ownerId, replacementOwnerId);

    releaseReplacement();
    assert.equal(await replacementLock, "replacement");
    assert.deepEqual(await lockArtifacts(dir), []);
  });
});

test("graph lock release failure leaves actionable owner metadata without corrupting graph", async () => {
  await withTempGraph(async (graphPath, dir) => {
    const before = await readFile(graphPath, "utf8");
    const lockPath = `${graphPath}.lock`;
    const restoreFaultInjector = installGraphIoFaultInjectorForTests((point) => {
      if (point === "before-lock-release") {
        throw new Error("injected lock release failure");
      }
    });

    try {
      await assert.rejects(
        withGraphLock(graphPath, async () => "locked", { retryMs: 1, timeoutMs: 500 }),
        /injected lock release failure/
      );
    } finally {
      restoreFaultInjector();
    }

    assert.equal(await readFile(graphPath, "utf8"), before);
    assert.equal((await readGraph(graphPath)).graphVersion, 1);
    const metadata = JSON.parse(await readFile(join(lockPath, "metadata.json"), "utf8"));
    assert.equal(metadata.lockVersion, 1);
    assert.match(metadata.ownerId, /^[0-9a-f-]{36}$/);
    assert.equal(metadata.pid, process.pid);
    assert.equal(metadata.graphPath, graphPath);
    const diagnostics = await diagnoseGraph(graphPath);
    assert.equal(diagnostics.lock.exists, true);
    assert.equal(diagnostics.lock.owner.ownerId, metadata.ownerId);
    assert.equal(diagnostics.lock.owner.pid, process.pid);
    assert.deepEqual(await lockArtifacts(dir), ["plan.graph.json.lock"]);
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
    await assert.rejects(
      writeReportFile(graphPath, join(dirname(dir), "escape.md"), "escaped report"),
      /Path escapes graph directory/
    );
    assert.deepEqual((await readdir(dir)).sort(), ["plan.graph.json", "reports"]);
  });
});

test("hostile default and explicit report paths stay contained", async () => {
  await withTempGraph(async (graphPath, dir) => {
    const generated = defaultReportPath("../A <script>alert(1)</script>\n# forged", "run/../../evil`*_~<@U123>");
    assert.match(generated, /^reports\/[^/]+\.md$/);
    assert.doesNotMatch(generated.slice("reports/".length), /<|>|\n|`|\*|~|@|\//, "generated file name should not carry markup or path separators");

    const generatedPath = await writeReportFile(graphPath, generated, "generated report");
    assert.equal(dirname(generatedPath), join(dir, "reports"));
    assert.equal(await readFile(generatedPath, "utf8"), "generated report\n");

    await assert.rejects(
      writeReportFile(graphPath, "reports/../../escape.md", "escaped report"),
      /Path escapes graph directory/
    );
    await writeFile(join(dir, "reports", "file-parent"), "not a directory\n", "utf8");
    await assert.rejects(
      writeReportFile(graphPath, "reports/file-parent/escape.md", "not a directory"),
      /Report path parent is not a directory/
    );
  });
});

test("report writes reject symlink escapes from the graph directory", async () => {
  await withTempGraph(async (graphPath, dir) => {
    const outsideDir = await mkdtemp(join(tmpdir(), "plan-report-outside-"));
    try {
      await symlink(outsideDir, join(dir, "linked-reports"), "dir");
      await assert.rejects(
        writeReportFile(graphPath, "linked-reports/escape.md", "escaped report"),
        /Path escapes graph directory through symbolic link/
      );
      assert.deepEqual(await readdir(outsideDir), []);

      await mkdir(join(dir, "reports"));
      const outsideFile = join(outsideDir, "outside.md");
      await writeFile(outsideFile, "outside\n", "utf8");
      await symlink(outsideFile, join(dir, "reports", "escape.md"));
      await assert.rejects(
        writeReportFile(graphPath, "reports/escape.md", "escaped report"),
        /Path escapes graph directory through symbolic link/
      );
      assert.equal(await readFile(outsideFile, "utf8"), "outside\n");
    } finally {
      await rm(outsideDir, { recursive: true, force: true });
    }
  });
});

test("operational event taxonomy has stable names and field contracts", () => {
  const requiredEvents = [
    "claimed",
    "running",
    "renewed",
    "done",
    "blocked",
    "answered",
    "failed",
    "reset",
    "decomposed",
    "expired",
    "clone-prepared",
    "branch-created",
    "output-ref-recorded",
    "merge-attempted",
    "merge-conflicted",
    "parent-ref-published",
    "worker-started",
    "worker-stopped",
    "lock-acquired",
    "lock-released",
    "lock-stale-reaped",
    "lock-timeout"
  ];
  const eventNames = operationalEventTaxonomy.map((entry) => entry.name);

  assert.equal(new Set(eventNames).size, eventNames.length);
  for (const eventName of requiredEvents) {
    assert.ok(eventNames.includes(eventName), `Missing event taxonomy entry for ${eventName}`);
    assert.doesNotMatch(eventName, /_/);
  }
  for (const entry of operationalEventTaxonomy) {
    assert.ok(entry.stableFields.includes("at"), `${entry.name} should include at`);
    assert.ok(entry.stableFields.includes("event"), `${entry.name} should include event`);
    assert.ok(["graph-history", "worker-manager", "graph-lock"].includes(entry.producer));
  }
  assert.equal(operationalEvents.expired, "expired");
  assert.equal(operationalEvents.clonePrepared, "clone-prepared");
  assert.equal(operationalEvents.mergeConflicted, "merge-conflicted");
  assert.equal(operationalEvents.workerStarted, "worker-started");
  assert.equal(operationalEvents.lockTimeout, "lock-timeout");
});

test("operational event redaction removes secret-shaped values from history payloads", async () => {
  assert.deepEqual(redactOperationalEventDetails({
    webhook: "SLACK_WEBHOOK_URL=https://hooks.slack.com/services/T000/B000/SECRET",
    auth: "Authorization: Bearer abc.def.ghi",
    remote: "https://user:token@example.com/org/repo.git",
    nested: { token: "token=super-secret" }
  }), {
    webhook: "SLACK_WEBHOOK_URL=[REDACTED]",
    auth: "Authorization: [REDACTED]",
    remote: "https://[REDACTED]@example.com/org/repo.git",
    nested: { token: "token=[REDACTED]" }
  });

  await withTempGraph(async (graphPath) => {
    await claimNode(graphPath, { session: "codex-A", nodeId: "A" });
    await blockNode(graphPath, {
      nodeId: "A",
      session: "codex-A",
      question: "Use token=super-secret and https://hooks.slack.com/services/T000/B000/SECRET?",
      reason: "password=hunter2"
    });

    const graph = await readGraph(graphPath);
    const entry = lastHistory(graph.graph.nodes.A);
    assert.equal(entry.event, "blocked");
    assert.match(entry.question, /token=\[REDACTED\]/);
    assert.match(entry.question, /hooks\.slack\.com\/services\/\[REDACTED\]/);
    assert.equal(entry.blockedReason, "password=[REDACTED]");
  });
});

test("operational event export flattens recent redacted history entries", async () => {
  await withTempGraph(async (graphPath) => {
    const graph = await readGraph(graphPath);
    graph.graph.nodes.A.status = "blocked";
    graph.graph.nodes.A.history = [
      {
        at: "2026-05-27T00:00:00.000Z",
        event: "claimed",
        status: "claimed",
        session: "codex-A",
        runId: "run_A",
        leaseExpiresAt: "2026-05-27T00:30:00.000Z"
      },
      {
        at: "2026-05-27T00:01:00.000Z",
        event: "blocked",
        previousStatus: "running",
        status: "blocked",
        session: "codex-A",
        runId: "run_A",
        blockedAt: "2026-05-27T00:01:00.000Z",
        question: "Use token=super-secret and https://hooks.slack.com/services/T000/B000/SECRET?",
        nested: { remote: "https://user:token@example.com/org/repo.git" }
      }
    ];
    graph.graph.nodes.B.history = [
      {
        at: "2026-05-27T00:02:00.000Z",
        event: "failed",
        status: "failed",
        session: "codex-B",
        runId: "run_B",
        failedAt: "2026-05-27T00:02:00.000Z",
        failureReason: "password=hunter2"
      }
    ];
    await writeFile(graphPath, `${JSON.stringify(graph, null, 2)}\n`, "utf8");

    const events = exportOperationalEvents(await readGraph(graphPath), { nodeId: "A", limit: 1 });
    assert.deepEqual(events, [
      {
        at: "2026-05-27T00:01:00.000Z",
        event: "blocked",
        nodeId: "A",
        status: "blocked",
        session: "codex-A",
        runId: "run_A",
        timestamps: {
          at: "2026-05-27T00:01:00.000Z",
          blockedAt: "2026-05-27T00:01:00.000Z"
        },
        details: {
          previousStatus: "running",
          question: "Use token=[REDACTED] and https://hooks.slack.com/services/[REDACTED]?",
          nested: { remote: "https://[REDACTED]@example.com/org/repo.git" }
        }
      }
    ]);

    const cliEvents = await captureSchedulerCli(["events", "--graph", graphPath, "--event", "failed", "--limit", "5"]);
    assert.equal(cliEvents.exitCode, 0);
    assert.equal(cliEvents.stdout[0].nodeId, "B");
    assert.equal(cliEvents.stdout[0].details.failureReason, "password=[REDACTED]");
  });
});

test("graph validator reports non-fatal warnings separately from errors", async () => {
  await withTempGraph(async (graphPath) => {
    const graph = fixtureGraph();
    graph.graph.nodes.ORPHAN = {
      title: "Detached legacy work",
      kind: "legacy-kind",
      status: "waiting-for-review"
    };
    await writeFile(graphPath, `${JSON.stringify(graph, null, 2)}\n`, "utf8");

    const validation = validatePlanGraphFileResult(graph);
    assert.deepEqual(validation.errors, []);
    assert.ok(validation.warnings.some((issue) => issue.path === "$.graph.nodes.ORPHAN" && /not reachable/.test(issue.message)));
    assert.ok(validation.warnings.some((issue) => issue.path === "$.graph.nodes.ORPHAN.kind" && /Unknown node kind/.test(issue.message)));
    assert.ok(validation.warnings.some((issue) => issue.path === "$.graph.nodes.ORPHAN.status" && /Unknown node status/.test(issue.message)));

    const ready = await execFileAsync(process.execPath, [schedulerScriptPath, "ready", "--graph", graphPath]);
    assert.deepEqual(JSON.parse(ready.stdout).map((node) => node.id), ["A"]);
  });
});
