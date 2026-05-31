import assert from "node:assert/strict";
import test, { after } from "node:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "@playwright/test";

const schedulerScriptUrl = new URL("../dist/scripts/plan-scheduler.js", import.meta.url);
if (!existsSync(fileURLToPath(schedulerScriptUrl))) {
  throw new Error("Missing dist/scripts/plan-scheduler.js. Run npm run build before visualizer browser tests.");
}

const {
  blockNode,
  claimNode,
  createVisualizerServer,
  readGraph,
  startNode
} = await import(schedulerScriptUrl.href);

const originalSlackWebhookUrl = process.env.SLACK_WEBHOOK_URL;
delete process.env.SLACK_WEBHOOK_URL;

const browserArtifactDir = process.env.SPG_BROWSER_ARTIFACT_DIR;
const requireBrowser = process.env.SPG_REQUIRE_BROWSER === "1" || process.env.CI === "true";

after(() => {
  if (originalSlackWebhookUrl === undefined) {
    delete process.env.SLACK_WEBHOOK_URL;
  } else {
    process.env.SLACK_WEBHOOK_URL = originalSlackWebhookUrl;
  }
});

async function ensureBrowserArtifactDir() {
  if (!browserArtifactDir) {
    return undefined;
  }
  await mkdir(browserArtifactDir, { recursive: true });
  return browserArtifactDir;
}

async function writeBrowserArtifact(fileName, contents) {
  const artifactDir = await ensureBrowserArtifactDir();
  if (!artifactDir) {
    return;
  }
  await writeFile(join(artifactDir, fileName), contents, "utf8");
}

async function capturePageDiagnostics(page, slug, graphPath) {
  const artifactDir = await ensureBrowserArtifactDir();
  if (!artifactDir) {
    return;
  }

  try {
    await page.screenshot({ path: join(artifactDir, `${slug}-failure.png`), fullPage: true });
  } catch (error) {
    await writeBrowserArtifact(`${slug}-screenshot-error.txt`, error instanceof Error ? error.stack ?? error.message : String(error));
  }

  try {
    await writeBrowserArtifact(`${slug}-failure.html`, await page.content());
  } catch (error) {
    await writeBrowserArtifact(`${slug}-html-error.txt`, error instanceof Error ? error.stack ?? error.message : String(error));
  }

  try {
    await writeBrowserArtifact(`${slug}-graph.json`, await readFile(graphPath, "utf8"));
  } catch (error) {
    await writeBrowserArtifact(`${slug}-graph-error.txt`, error instanceof Error ? error.stack ?? error.message : String(error));
  }
}

async function runWithPageDiagnostics(page, slug, graphPath, fn) {
  try {
    await fn();
  } catch (error) {
    await capturePageDiagnostics(page, slug, graphPath);
    throw error;
  }
}

function browserFixtureGraph() {
  return {
    graphVersion: 1,
    title: "Browser Visualizer Plan",
    description: "Fixture for real browser visualizer interactions.",
    graph: {
      root: "ROOT",
      nodes: {
        ROOT: { title: "Root", kind: "parallel", status: "pending", children: ["A", "B", "C"] },
        A: { title: "Blocked task", kind: "task", status: "pending" },
        B: { title: "SSE task", kind: "task", status: "pending" },
        C: { title: "Completed task", kind: "task", status: "done" }
      }
    }
  };
}

function completedBrowserFixtureGraph() {
  const graph = browserFixtureGraph();
  for (const node of Object.values(graph.graph.nodes)) {
    node.status = "done";
  }
  return graph;
}

function metadataApprovalBrowserFixtureGraph() {
  return {
    graphVersion: 1,
    title: "Planner Approval And Git Metadata Plan",
    description: "Fixture for browser-visible planner approval and Git provenance.",
    graph: {
      root: "ROOT",
      nodes: {
        ROOT: {
          title: "Metadata root",
          kind: "parallel",
          status: "pending",
          children: ["APPROVAL", "IMPLEMENT"]
        },
        APPROVAL: {
          title: "Approve planner preview",
          kind: "task",
          status: "blocked",
          session: "codex-planner-approval",
          runId: "run_approval_preview",
          lease: {
            session: "codex-planner-approval",
            runId: "run_approval_preview",
            claimedAt: "2026-05-31T00:00:00.000Z",
            expiresAt: "2026-05-31T00:30:00.000Z"
          },
          question: "Planner proposed series decomposition; approve by decomposing this node?",
          blockedReason: "planner approval required",
          report: "reports/APPROVAL-planner-preview.md",
          goal: { text: "Approve the planner preview safely", source: "planner" },
          planner: {
            name: "codex",
            model: "gpt-5",
            requestId: "worker-plan-APPROVAL-run_approval_preview",
            decision: "Split approval work into one implementation child",
            decompositionReason: "ask-approval mode parks valid planner output for operator review"
          },
          pendingPlannerPreview: {
            requestId: "worker-plan-APPROVAL-run_approval_preview",
            sourceGraphVersion: 1,
            graphVersion: 1,
            nodeState: {
              status: "blocked",
              kind: "task",
              lease: { session: "codex-planner-approval", runId: "run_approval_preview" },
              blockedReason: "planner approval required",
              question: "Planner proposed series decomposition; approve by decomposing this node?",
              report: "reports/APPROVAL-planner-preview.md"
            },
            proposedKind: "series",
            childIds: ["APPROVALa"],
            report: "reports/APPROVAL-planner-preview.md",
            response: {
              kind: "series",
              title: "Approve planner preview",
              children: [{ id: "APPROVALa", title: "Approved child" }]
            },
            decompose: {
              kind: "series",
              children: [{ id: "APPROVALa", title: "Approved child", kind: "task" }]
            }
          },
          history: [
            {
              at: "2026-05-31T00:00:01.000Z",
              event: "planner-preview-rejected",
              session: "codex-planner-approval",
              runId: "run_approval_preview",
              requestId: "worker-plan-APPROVAL-run_approval_preview",
              proposedKind: "series",
              childIds: ["APPROVALa"],
              reason: "planner approval required",
              report: "reports/APPROVAL-planner-preview.md"
            },
            {
              at: "2026-05-31T00:00:02.000Z",
              event: "blocked",
              session: "codex-planner-approval",
              runId: "run_approval_preview"
            }
          ]
        },
        IMPLEMENT: {
          title: "Inspect changed files",
          kind: "task",
          status: "running",
          session: "codex-git",
          runId: "run_git_metadata",
          goal: {
            text: "Add searchable audit log documentation",
            source: "planner",
            createdAt: "2026-05-31T00:01:00.000Z"
          },
          planner: {
            name: "codex",
            model: "gpt-5",
            requestId: "plan-20260531-audit-log-implement",
            plannedAt: "2026-05-31T00:01:00.000Z",
            decision: "Implement the smallest user-visible documentation slice first",
            decompositionReason: "The goal is narrow enough for one leaf task"
          },
          contextRefs: [
            { type: "file", ref: "README.md", title: "Operator quickstart" },
            { type: "node", ref: "APPROVAL", nodeId: "APPROVAL", title: "Approval preview" }
          ],
          outputContract: {
            format: "markdown",
            requiredArtifacts: ["docs/audit-log.md"],
            acceptanceCriteria: ["Summary output validates with the scheduler."]
          },
          baseRef: {
            name: "refs/remotes/origin/main",
            commit: "0000000000000000000000000000000000000001",
            source: "graph-default",
            resolvedAt: "2026-05-31T00:01:10.000Z"
          },
          workRef: {
            name: "refs/heads/spg/node/IMPLEMENT/run_git_metadata",
            commit: "0000000000000000000000000000000000000002",
            runId: "run_git_metadata",
            session: "codex-git",
            createdAt: "2026-05-31T00:01:10.000Z"
          },
          outputRef: {
            name: "refs/heads/spg/node/IMPLEMENT/run_git_metadata",
            commit: "0000000000000000000000000000000000000003",
            runId: "run_git_metadata",
            session: "codex-git",
            report: "reports/IMPLEMENT.md",
            diffStat: {
              filesChanged: 1,
              insertions: 12,
              deletions: 2,
              totalChanges: 14,
              binaryFiles: 0
            },
            files: [
              {
                path: "docs/audit-log.md",
                changeType: "modified",
                insertions: 12,
                deletions: 2,
                totalChanges: 14,
                binary: false
              }
            ],
            producedAt: "2026-05-31T00:10:20.000Z"
          },
          gitFootprint: {
            source: "git-diff",
            branch: "spg/node/IMPLEMENT/run_git_metadata",
            commit: "0000000000000000000000000000000000000003",
            remote: "https://user:secret-token@example.com/org/repo.git",
            workspace: { cloneCwd: "/tmp/spg/token=workspace-secret/workspaces/codex-git/IMPLEMENT" },
            diffStat: {
              filesChanged: 1,
              insertions: 12,
              deletions: 2,
              totalChanges: 14,
              binaryFiles: 0
            },
            files: [
              {
                path: "docs/audit-log.md",
                changeType: "modified",
                insertions: 12,
                deletions: 2,
                totalChanges: 14,
                binary: false
              }
            ],
            collectedAt: "2026-05-31T00:10:30.000Z"
          },
          history: [
            { at: "2026-05-31T00:01:10.000Z", event: "claimed", session: "codex-git", runId: "run_git_metadata" },
            { at: "2026-05-31T00:01:11.000Z", event: "running", session: "codex-git", runId: "run_git_metadata" },
            { at: "2026-05-31T00:10:20.000Z", event: "output-ref-recorded", session: "codex-git", runId: "run_git_metadata" }
          ]
        }
      }
    }
  };
}

function layoutRegressionGraphs() {
  const seriesIds = Array.from({ length: 18 }, (_, index) => `L${index + 1}`);
  const wideIds = Array.from({ length: 12 }, (_, index) => `W${index + 1}`);
  const longId = "LONG_NODE_ID_0123";

  return [
    {
      slug: "small",
      graph: {
        graphVersion: 1,
        title: "Small Layout Plan",
        graph: {
          root: "ROOT",
          nodes: {
            ROOT: { title: "Small root", kind: "series", status: "pending", children: ["A", "B"] },
            A: { title: "Prepare short input", kind: "task", status: "pending" },
            B: { title: "Complete small plan", kind: "task", status: "done" }
          }
        }
      }
    },
    {
      slug: "wide",
      graph: {
        graphVersion: 1,
        title: "Wide Parallel Layout Plan",
        graph: {
          root: "ROOT",
          nodes: {
            ROOT: { title: "Wide root", kind: "parallel", status: "pending", children: wideIds },
            ...Object.fromEntries(wideIds.map((id, index) => [
              id,
              { title: `Parallel branch ${index + 1} validates labels`, kind: "task", status: index % 3 === 0 ? "done" : "pending" }
            ]))
          }
        }
      }
    },
    {
      slug: "deep",
      graph: {
        graphVersion: 1,
        title: "Deep Nested Layout Plan",
        graph: {
          root: "ROOT",
          nodes: {
            ROOT: { title: "Deep root", kind: "series", status: "pending", children: ["SETUP", "NEST_1", "WRAP"] },
            SETUP: { title: "Setup task", kind: "task", status: "done" },
            NEST_1: { title: "Nested one", kind: "parallel", status: "pending", children: ["NEST_2", "SIDE_A"] },
            NEST_2: { title: "Nested two", kind: "series", status: "pending", children: ["SIDE_B", "NEST_3"] },
            NEST_3: { title: "Nested three", kind: "parallel", status: "pending", children: ["SIDE_C", "DEEP_LEAF"] },
            SIDE_A: { title: "Side branch A", kind: "task", status: "pending" },
            SIDE_B: { title: "Side branch B", kind: "task", status: "done" },
            SIDE_C: { title: "Side branch C", kind: "task", status: "pending" },
            DEEP_LEAF: { title: "Deep branch label wraps cleanly", kind: "task", status: "running" },
            WRAP: { title: "Wrap up", kind: "task", status: "pending" }
          }
        }
      }
    },
    {
      slug: "blocked",
      graph: {
        graphVersion: 1,
        title: "Blocked Layout Plan",
        graph: {
          root: "ROOT",
          nodes: {
            ROOT: { title: "Blocked root", kind: "series", status: "pending", children: ["BLOCKED", "NEXT"] },
            BLOCKED: { title: "Waiting on operator answer", kind: "task", status: "blocked", question: "Proceed with cached output?" },
            NEXT: { title: "Next pending task", kind: "task", status: "pending" }
          }
        }
      }
    },
    {
      slug: "failed",
      graph: {
        graphVersion: 1,
        title: "Failed Layout Plan",
        graph: {
          root: "ROOT",
          nodes: {
            ROOT: { title: "Failed root", kind: "parallel", status: "pending", children: ["FAILED", "RECOVERY"] },
            FAILED: { title: "Failed branch keeps content visible", kind: "task", status: "failed", report: "reports/FAILED.md" },
            RECOVERY: { title: "Recovery branch", kind: "task", status: "pending" }
          }
        }
      }
    },
    {
      slug: "running",
      graph: {
        graphVersion: 1,
        title: "Running Layout Plan",
        graph: {
          root: "ROOT",
          nodes: {
            ROOT: { title: "Running root", kind: "series", status: "pending", children: ["RUNNING", "DONE"] },
            RUNNING: { title: "Running worker branch", kind: "task", status: "running", session: "codex-layout" },
            DONE: { title: "Already completed branch", kind: "task", status: "done" }
          }
        }
      }
    },
    {
      slug: "hostile-long-text",
      graph: {
        graphVersion: 1,
        title: "Layout Stress <script>alert(1)</script>",
        graph: {
          root: "ROOT",
          nodes: {
            ROOT: { title: "Root with long child labels", kind: "parallel", status: "pending", children: [longId, "BLOCKED_LONG", "FAILED_LONG"] },
            [longId]: {
              title: "A very long pending title that should wrap or truncate safely without overlapping neighboring nodes or controls",
              kind: "task",
              status: "pending",
              report: "reports/long-id-<script>alert(1)</script>.md"
            },
            BLOCKED_LONG: {
              title: "Blocked question with malicious-looking markup",
              kind: "task",
              status: "blocked",
              question: "Can this proceed after <img src=x onerror=alert(1)> while preserving a very long operator question?",
              blockedReason: "Waiting for <script>alert(1)</script> confirmation"
            },
            FAILED_LONG: {
              title: "Failed reason remains visible",
              kind: "task",
              status: "failed",
              failureReason: "Failure from <script>alert(1)</script> with a long explanation that should not push controls over each other.",
              report: "reports/FAILED_LONG_<img>.md"
            }
          }
        }
      }
    },
    {
      slug: "large",
      graph: {
        graphVersion: 1,
        title: "Large Layout Plan",
        graph: {
          root: "ROOT",
          nodes: {
            ROOT: { title: "Large root", kind: "series", status: "pending", children: seriesIds },
            ...Object.fromEntries(seriesIds.map((id, index) => [
              id,
              { title: `Large plan task ${index + 1} with readable title`, kind: "task", status: index % 5 === 0 ? "done" : "pending" }
            ]))
          }
        }
      }
    }
  ];
}

function leafNodeIds(graph) {
  return Object.entries(graph.graph.nodes)
    .filter(([, node]) => !Array.isArray(node.children) || node.children.length === 0)
    .map(([id]) => id);
}

function frameNodeIds(graph) {
  return Object.entries(graph.graph.nodes)
    .filter(([, node]) => Array.isArray(node.children) && node.children.length > 0)
    .map(([id]) => id);
}

async function withTempGraph(graphFactory, fn) {
  const dir = await mkdtemp(join(tmpdir(), "spg-visualizer-browser-"));
  const graphPath = join(dir, "plan.graph.json");
  await writeFile(graphPath, `${JSON.stringify(graphFactory(), null, 2)}\n`, "utf8");
  try {
    await fn(graphPath, dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function assertGraphLayoutInvariants(page, graph) {
  const expectedLeafIds = leafNodeIds(graph);
  const expectedFrameIds = frameNodeIds(graph);
  const result = await page.locator("#graph svg.sp-graph").evaluate((svg, expected) => {
    const parseNumber = (value) => Number.parseFloat(value || "0");
    const cssEscape = globalThis.CSS?.escape || ((value) => String(value).replaceAll(/[^a-zA-Z0-9_-]/g, "\\$&"));
    const intersects = (a, b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
    const padded = (box, padding) => ({
      left: box.left + padding,
      right: box.right - padding,
      top: box.top + padding,
      bottom: box.bottom - padding
    });
    const svgRect = svg.getBoundingClientRect();
    const viewBox = svg.viewBox.baseVal;
    const failures = [];
    const nodeBoxes = [...svg.querySelectorAll("g.sp-node")].map((nodeGroup) => {
      const rect = nodeGroup.querySelector("rect");
      const box = {
        id: nodeGroup.getAttribute("data-id"),
        left: parseNumber(rect?.getAttribute("x")),
        top: parseNumber(rect?.getAttribute("y")),
        width: parseNumber(rect?.getAttribute("width")),
        height: parseNumber(rect?.getAttribute("height"))
      };
      return { ...box, right: box.left + box.width, bottom: box.top + box.height };
    });
    const frameBoxes = [...svg.querySelectorAll("g.sp-frame")].map((frameGroup) => {
      const rect = frameGroup.querySelector("rect");
      const box = {
        id: frameGroup.getAttribute("data-id"),
        left: parseNumber(rect?.getAttribute("x")),
        top: parseNumber(rect?.getAttribute("y")),
        width: parseNumber(rect?.getAttribute("width")),
        height: parseNumber(rect?.getAttribute("height"))
      };
      return { ...box, right: box.left + box.width, bottom: box.top + box.height };
    });

    if (svgRect.width <= 0 || svgRect.height <= 0 || viewBox.width <= 0 || viewBox.height <= 0) {
      failures.push(`graph SVG has invalid dimensions: rect=${svgRect.width}x${svgRect.height}, viewBox=${viewBox.width}x${viewBox.height}`);
    }

    for (const id of expected.leafIds) {
      if (!svg.querySelector(`g.sp-node[data-id="${cssEscape(id)}"]`)) {
        failures.push(`missing leaf node ${id}`);
      }
    }

    for (const id of expected.frameIds) {
      if (!svg.querySelector(`g.sp-frame[data-id="${cssEscape(id)}"]`)) {
        failures.push(`missing frame node ${id}`);
      }
    }

    const allGraphics = [...svg.querySelectorAll("g.sp-node rect, g.sp-frame rect, path.sp-edge, g.sp-terminal circle")];
    for (const element of allGraphics) {
      const box = element.getBoundingClientRect();
      if (
        box.left < svgRect.left - 0.5
        || box.top < svgRect.top - 0.5
        || box.right > svgRect.right + 0.5
        || box.bottom > svgRect.bottom + 0.5
      ) {
        failures.push(`element ${element.tagName}.${element.getAttribute("class") || ""} outside rendered SVG bounds`);
      }
    }

    for (let index = 0; index < nodeBoxes.length; index += 1) {
      for (let otherIndex = index + 1; otherIndex < nodeBoxes.length; otherIndex += 1) {
        if (intersects(nodeBoxes[index], nodeBoxes[otherIndex])) {
          failures.push(`overlapping nodes ${nodeBoxes[index].id} and ${nodeBoxes[otherIndex].id}`);
        }
      }
    }

    for (const nodeGroup of svg.querySelectorAll("g.sp-node")) {
      const rect = nodeGroup.querySelector("rect");
      const bounds = padded({
        left: parseNumber(rect?.getAttribute("x")),
        top: parseNumber(rect?.getAttribute("y")),
        right: parseNumber(rect?.getAttribute("x")) + parseNumber(rect?.getAttribute("width")),
        bottom: parseNumber(rect?.getAttribute("y")) + parseNumber(rect?.getAttribute("height"))
      }, 8);
      for (const text of nodeGroup.querySelectorAll("text")) {
        const textBox = text.getBBox();
        if (
          textBox.x < bounds.left - 0.5
          || textBox.y < bounds.top - 0.5
          || textBox.x + textBox.width > bounds.right + 0.5
          || textBox.y + textBox.height > bounds.bottom + 0.5
        ) {
          failures.push(`clipped node label in ${nodeGroup.getAttribute("data-id")}: ${text.textContent?.trim()}`);
        }
      }
    }

    return {
      failures,
      leafCount: nodeBoxes.length,
      frameCount: frameBoxes.length,
      edgeCount: svg.querySelectorAll("path.sp-edge").length,
      width: viewBox.width,
      height: viewBox.height
    };
  }, { leafIds: expectedLeafIds, frameIds: expectedFrameIds });

  assert.deepEqual(result.failures, [], `${graph.title} layout failures`);
  assert.equal(result.leafCount, expectedLeafIds.length, `${graph.title} should render every leaf node`);
  assert.equal(result.frameCount, expectedFrameIds.length, `${graph.title} should render every internal frame`);
  assert.ok(result.edgeCount > 0, `${graph.title} should render connector edges`);
  assert.ok(result.width > 0 && result.height > 0, `${graph.title} should render non-empty graph content`);
}

async function launchChromiumOrSkip(t) {
  try {
    return await chromium.launch();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("Executable doesn't exist") || message.includes("playwright install")) {
      if (requireBrowser) {
        throw new Error("Playwright Chromium is required in CI. Run: npx playwright install --with-deps chromium", { cause: error });
      }
      t.skip("Playwright Chromium is not installed. Run: npx playwright install chromium");
      return undefined;
    }
    throw error;
  }
}

async function submitModal(page) {
  await page.locator(".modal-dialog button[type=submit]").click();
  await page.locator(".modal-dialog").waitFor({ state: "detached" });
}

async function waitForGraphCondition(graphPath, predicate, timeoutMs = 8000) {
  const start = Date.now();
  let graph = await readGraph(graphPath);
  while (!predicate(graph)) {
    if (Date.now() - start > timeoutMs) {
      assert.fail("Timed out waiting for graph condition");
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
    graph = await readGraph(graphPath);
  }
  return graph;
}

test("visualizer selected-node actions claim, start, block, answer, and reset ready work", async (t) => {
  const browser = await launchChromiumOrSkip(t);
  if (!browser) {
    return;
  }

  try {
    await withTempGraph(browserFixtureGraph, async (graphPath, dir) => {
      const visualizer = await createVisualizerServer({ graphPath, port: 0, defaultWorkerCwd: dir });
      const context = await browser.newContext({ viewport: { width: 390, height: 900 } });
      try {
        const page = await context.newPage();
        page.setDefaultTimeout(10000);
        await runWithPageDiagnostics(page, "visualizer-selected-node-actions", graphPath, async () => {
          await page.goto(visualizer.url);
          await page.getByRole("heading", { name: "Node Detail" }).waitFor();
          await page.locator('#ready [data-select-node="A"]').click();
          await page.locator("#selected-node-details", { hasText: "Blocked task" }).waitFor();

          await page.locator('[data-node-action="claim-selected"]').click();
          await page.locator(".modal-dialog").getByLabel("Session").fill("operator-A");
          await page.locator(".modal-dialog").getByLabel("Lease Seconds").fill("60");
          await submitModal(page);
          await page.locator("#working", { hasText: "operator-A" }).waitFor();
          assert.equal((await readGraph(graphPath)).graph.nodes.A.status, "claimed");

          await page.locator('[data-node-action="start"]').click();
          await submitModal(page);
          await page.locator("#selected-node-details", { hasText: "running" }).waitFor();
          assert.equal((await readGraph(graphPath)).graph.nodes.A.status, "running");

          await page.locator('[data-node-action="block"]').click();
          await page.locator(".modal-dialog").getByLabel("Question").fill("Need operator decision?");
          await page.locator(".modal-dialog").getByLabel("Reason").fill("needs_operator_decision");
          await submitModal(page);
          await page.getByLabel("Answer for A").waitFor();
          assert.equal((await readGraph(graphPath)).graph.nodes.A.status, "blocked");

          await page.getByLabel("Answer for A").fill("Continue with cached output.");
          await page.locator('form[data-answer-form][data-node-id="A"] button[type="submit"]').click();
          await page.locator("#ready", { hasText: "Continue with cached output." }).waitFor();
          assert.equal((await readGraph(graphPath)).graph.nodes.A.status, "pending");

          await page.locator('#ready [data-select-node="A"]').click();
          await page.locator('[data-node-action="reset"]').click();
          await page.locator(".modal-dialog").getByLabel("Reason").fill("browser workflow retry");
          await submitModal(page);
          await page.locator("#ready", { hasText: "Blocked task" }).waitFor();

          const graphAfterReset = await readGraph(graphPath);
          assert.equal(graphAfterReset.graph.nodes.A.status, "pending");
          assert.equal(graphAfterReset.graph.nodes.A.lease, undefined);
        });
      } finally {
        await context.close();
        await visualizer.close();
      }
    });
  } finally {
    await browser.close();
  }
});

test("visualizer goal planner previews and creates a fixture-generated graph with write token", async (t) => {
  const browser = await launchChromiumOrSkip(t);
  if (!browser) {
    return;
  }

  try {
    await withTempGraph(browserFixtureGraph, async (graphPath, dir) => {
      await writeFile(join(dir, "planner-fixture.json"), JSON.stringify({
        kind: "series",
        title: "Fixture-generated browser plan",
        rationale: "Create the contract before implementation.",
        children: [
          { id: "GOAL_CONTRACT", title: "Define browser contract" },
          { id: "GOAL_IMPLEMENT", title: "Implement browser goal" },
          { id: "GOAL_VERIFY", title: "Verify browser goal" }
        ]
      }, null, 2), "utf8");

      const visualizer = await createVisualizerServer({
        graphPath,
        port: 0,
        defaultWorkerCwd: dir,
        writeToken: "goal-secret"
      });
      const context = await browser.newContext({ viewport: { width: 420, height: 960 } });
      try {
        const forbidden = await fetch(`${visualizer.url}/api/goal/plan`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ goal: "Forbidden browser goal", dryRun: true })
        });
        assert.equal(forbidden.status, 403);

        const page = await context.newPage();
        page.setDefaultTimeout(10000);
        await runWithPageDiagnostics(page, "visualizer-goal-planner", graphPath, async () => {
          await page.goto(`${visualizer.url}/#write-token=goal-secret`);
          await page.getByRole("heading", { name: "Goal Planner" }).waitFor();
          await page.getByRole("textbox", { name: "Goal" }).fill("Build a browser-created graph");
          await page.getByLabel("Title").fill("Browser Created Goal Plan");
          await page.getByLabel("Planner Fixture").fill("planner-fixture.json");

          await page.getByRole("button", { name: "Preview" }).click();
          await page.locator("#goal-planner-result", { hasText: "Preview graph" }).waitFor();
          await page.locator("#goal-planner-result", { hasText: "GOAL_CONTRACT, GOAL_IMPLEMENT, GOAL_VERIFY" }).waitFor();
          assert.equal((await readGraph(graphPath)).title, "Browser Visualizer Plan");

          await page.getByRole("button", { name: "Create Graph" }).click();
          await page.locator("#goal-planner-result", { hasText: "Created graph" }).waitFor();
          await page.locator("#subtitle", { hasText: "4 nodes" }).waitFor();
          await page.locator("#ready", { hasText: "Define browser contract" }).waitFor();
          await page.locator("#graph", { hasText: "GOAL_CONTRACT" }).waitFor();

          const graph = await readGraph(graphPath);
          assert.equal(graph.title, "Browser Created Goal Plan");
          assert.equal(graph.graph.nodes.ROOT.kind, "series");
          assert.deepEqual(graph.graph.nodes.ROOT.children, ["GOAL_CONTRACT", "GOAL_IMPLEMENT", "GOAL_VERIFY"]);
          assert.equal(graph.graph.nodes.ROOT.goal.text, "Build a browser-created graph");
        });
      } finally {
        await context.close();
        await visualizer.close();
      }
    });
  } finally {
    await browser.close();
  }
});

test("visualizer page loads, answers blocked tasks, and receives SSE updates", async (t) => {
  const browser = await launchChromiumOrSkip(t);
  if (!browser) {
    return;
  }

  try {
    await withTempGraph(browserFixtureGraph, async (graphPath, dir) => {
      await claimNode(graphPath, { session: "codex-A", nodeId: "A" });
      await blockNode(graphPath, { nodeId: "A", session: "codex-A", question: "Use cached result?" });

      const visualizer = await createVisualizerServer({ graphPath, port: 0, defaultWorkerCwd: dir });
      const context = await browser.newContext();
      try {
        const page = await context.newPage();
        page.setDefaultTimeout(8000);
        await runWithPageDiagnostics(page, "visualizer-core-panels-sse", graphPath, async () => {
          await page.goto(visualizer.url);

          await page.getByRole("heading", { name: "Graph", exact: true }).waitFor();
          await page.getByRole("heading", { name: "Worker Manager" }).waitFor();
          await page.getByRole("heading", { name: "Active Sessions" }).waitFor();
          await page.getByRole("heading", { name: "Ready Leaf Nodes" }).waitFor();
          await page.locator("#graph svg.sp-graph").waitFor();
          await page.locator("#working", { hasText: "Blocked task" }).waitFor();

          const artifactDir = await ensureBrowserArtifactDir();
          const screenshotPath = join(artifactDir ?? dir, "visualizer-core-panels.png");
          await page.screenshot({ path: screenshotPath, fullPage: true });
          assert.equal(existsSync(screenshotPath), true);

          await page.getByLabel("Answer for A").fill("Use cached result.");
          await page.locator('form[data-answer-form][data-node-id="A"] button[type="submit"]').click();
          await page.locator("#ready", { hasText: "Use cached result." }).waitFor();

          const graphAfterAnswer = await readGraph(graphPath);
          assert.equal(graphAfterAnswer.graph.nodes.A.status, "pending");
          assert.equal(graphAfterAnswer.graph.nodes.A.answer, "Use cached result.");
          assert.equal(graphAfterAnswer.graph.nodes.A.answeredBy, "visualizer");

          await claimNode(graphPath, { session: "external-sse", nodeId: "B" });
          await page.locator("#working", { hasText: "external-sse" }).waitFor();
          assert.match(await page.locator("#graph-filter-summary").textContent(), /active/);
        });
      } finally {
        await context.close();
        await visualizer.close();
      }
    });
  } finally {
    await browser.close();
  }
});

test("visualizer diagnostics and events views expose triage details and filters", async (t) => {
  const browser = await launchChromiumOrSkip(t);
  if (!browser) {
    return;
  }

  try {
    await withTempGraph(browserFixtureGraph, async (graphPath, dir) => {
      await claimNode(graphPath, { session: "codex-A", nodeId: "A" });
      await blockNode(graphPath, { nodeId: "A", session: "codex-A", question: "Use cached result?" });
      const graph = await readGraph(graphPath);
      graph.graph.nodes.C.status = "failed";
      graph.graph.nodes.C.failureReason = "browser diagnostics fixture";
      graph.graph.nodes.C.report = "reports/C.md";
      await writeFile(graphPath, `${JSON.stringify(graph, null, 2)}\n`, "utf8");

      const visualizer = await createVisualizerServer({ graphPath, port: 0, defaultWorkerCwd: dir });
      const context = await browser.newContext();
      try {
        const page = await context.newPage();
        page.setDefaultTimeout(8000);
        await runWithPageDiagnostics(page, "visualizer-diagnostics-events", graphPath, async () => {
          await page.goto(visualizer.url);
          await page.getByRole("heading", { name: "Diagnostics" }).waitFor();
          await page.getByRole("heading", { name: "Events" }).waitFor();
          await page.locator("#attention-dashboard", { hasText: "Blocked task" }).waitFor();
          await page.locator("#attention-dashboard", { hasText: "Completed task" }).waitFor();
          await page.locator("#diagnostics-panel", { hasText: "recommended actions" }).waitFor();
          await page.locator("#diagnostics-panel", { hasText: "A" }).waitFor();
          await page.locator("#events-list", { hasText: "blocked" }).waitFor();
          await page.locator("#events-list", { hasText: "claimed" }).waitFor();

          await page.fill("#event-node-filter", "A");
          await page.locator("#events-list", { hasText: "blocked" }).waitFor();
          await page.locator("#event-name-filter").selectOption("claimed");
          await page.locator("#events-list", { hasText: "claimed" }).waitFor();
          await page.locator("#events-list", { hasNotText: "blocked" }).waitFor();

          await page.locator('#working [data-select-node="A"]').click();
          await page.locator("#selected-node-details", { hasText: "History" }).waitFor();
          await page.locator("#selected-node-details", { hasText: "Newest first" }).waitFor();
        });
      } finally {
        await context.close();
        await visualizer.close();
      }
    });
  } finally {
    await browser.close();
  }
});

test("visualizer decompose builder validates dynamic children and mutates a running leaf", async (t) => {
  const browser = await launchChromiumOrSkip(t);
  if (!browser) {
    return;
  }

  try {
    await withTempGraph(browserFixtureGraph, async (graphPath, dir) => {
      await claimNode(graphPath, { session: "codex-A", nodeId: "A" });
      await startNode(graphPath, { nodeId: "A", session: "codex-A" });

      const visualizer = await createVisualizerServer({ graphPath, port: 0, defaultWorkerCwd: dir });
      const context = await browser.newContext();
      try {
        const page = await context.newPage();
        page.setDefaultTimeout(8000);
        await runWithPageDiagnostics(page, "visualizer-decompose-builder", graphPath, async () => {
          await page.goto(visualizer.url);
          await page.locator('#working [data-select-node="A"]').click();
          await page.locator('[data-node-action="decompose"]').click();
          await page.getByRole("heading", { name: "Decompose A" }).waitFor();
          await page.locator("[data-decompose-preview]", { hasText: "title cannot be empty" }).waitFor();

          await page.locator('form[data-decompose-form] button[type="submit"]').click();
          await page.locator("[data-modal-error]", { hasText: "title cannot be empty" }).waitFor();

          await page.locator('[name="childTitle"]').first().fill("Draft child");
          await page.locator("[data-decompose-add]").click();
          await page.locator('[name="childTitle"]').nth(1).fill("Verify child");
          await page.locator('[name="childId"]').nth(1).fill("Aa");
          await page.locator('form[data-decompose-form] button[type="submit"]').click();
          await page.locator("[data-modal-error]", { hasText: "Duplicate child id: Aa" }).waitFor();

          await page.locator('[name="childId"]').nth(1).fill("Ab");
          await page.locator('[name="childMetadata"]').first().fill('{"description":"from visualizer"}');
          await page.locator('[name="kind"]').selectOption("parallel");
          await page.locator('[data-decompose-move="up"]').nth(1).click();
          await page.locator("[data-decompose-preview]", { hasText: '"kind": "parallel"' }).waitFor();

          await page.locator("#decompose-session").fill("codex-A");
          await page.locator('form[data-decompose-form] button[type="submit"]').click();
          await page.locator(".modal-dialog").waitFor({ state: "detached" });
          await page.locator("#selected-node-details", { hasText: "Ab, Aa" }).waitFor();

          const graphAfterDecompose = await readGraph(graphPath);
          assert.equal(graphAfterDecompose.graph.nodes.A.kind, "parallel");
          assert.deepEqual(graphAfterDecompose.graph.nodes.A.children, ["Ab", "Aa"]);
          assert.equal(graphAfterDecompose.graph.nodes.A.status, "pending");
          assert.equal(graphAfterDecompose.graph.nodes.Aa.description, "from visualizer");
          assert.equal(graphAfterDecompose.graph.nodes.Ab.title, "Verify child");
        });
      } finally {
        await context.close();
        await visualizer.close();
      }
    });
  } finally {
    await browser.close();
  }
});

test("visualizer token-protected approval flow shows planner and changed-file provenance", async (t) => {
  const browser = await launchChromiumOrSkip(t);
  if (!browser) {
    return;
  }

  try {
    await withTempGraph(metadataApprovalBrowserFixtureGraph, async (graphPath, dir) => {
      await mkdir(join(dir, "reports"), { recursive: true });
      await writeFile(join(dir, "reports", "APPROVAL-planner-preview.md"), "Planner preview proposes APPROVALa.\n", "utf8");
      const visualizer = await createVisualizerServer({
        graphPath,
        port: 0,
        defaultWorkerCwd: dir,
        writeToken: "browser-secret"
      });
      const context = await browser.newContext({ viewport: { width: 390, height: 900 } });
      try {
        const page = await context.newPage();
        page.setDefaultTimeout(10000);
        await runWithPageDiagnostics(page, "visualizer-token-protected-provenance", graphPath, async () => {
          await page.goto(`${visualizer.url}/#write-token=browser-secret`);
          await page.locator("#graph svg.sp-graph").waitFor();
          await assertGraphLayoutInvariants(page, metadataApprovalBrowserFixtureGraph());

          await page.locator('#working [data-select-node="APPROVAL"]').click();
          await page.locator("#selected-node-details", { hasText: "Approve planner preview" }).waitFor();
          await page.locator("#selected-node-details", { hasText: "planner-preview-rejected" }).waitFor();
          await page.locator("#selected-node-details", { hasText: "goal: Approve the planner preview safely" }).waitFor();
          await page.locator("#selected-node-details", { hasText: "decision: Split approval work into one implementation child" }).waitFor();
          await page.locator("#selected-node-details", { hasText: "pending planner preview: request worker-plan-APPROVAL-run_approval_preview" }).waitFor();
          await page.locator("#selected-node-details", { hasText: "Planner Preview" }).waitFor();
          await page.locator('[data-node-action="apply-preview"]').waitFor();
          await page.locator('[data-node-action="reject-preview"]').waitFor();
          await page.locator('[data-node-action="regenerate-preview"]').waitFor();

          await page.locator('[data-node-action="decompose"]').click();
          await page.locator("[data-decompose-preview]", { hasText: '"title": "Approved child"' }).waitFor();
          await page.locator("[data-decompose-preview]", { hasText: '"nodeId": "APPROVAL"' }).waitFor();
          await page.locator("[data-decompose-preview]", { hasText: '"session": "codex-planner-approval"' }).waitFor();
          await page.locator('form[data-decompose-form] button[type="submit"]').click();
          await page.locator(".modal-dialog").waitFor({ state: "detached" });
          await page.locator("#selected-node-details", { hasText: "children: APPROVALa" }).waitFor();

          const approvedGraph = await readGraph(graphPath);
          assert.equal(approvedGraph.graph.nodes.APPROVAL.status, "pending");
          assert.deepEqual(approvedGraph.graph.nodes.APPROVAL.children, ["APPROVALa"]);
          assert.equal(approvedGraph.graph.nodes.APPROVALa.title, "Approved child");

          await page.locator('#working [data-select-node="IMPLEMENT"]').click();
          await page.locator("#selected-node-details", { hasText: "Inspect changed files" }).waitFor();
          await page.locator("#selected-node-details", { hasText: "goal: Add searchable audit log documentation" }).waitFor();
          await page.locator("#selected-node-details", { hasText: "decision: Implement the smallest user-visible documentation slice first" }).waitFor();
          await page.locator("#selected-node-details", { hasText: "Git Footprint" }).waitFor();
          await page.locator("#selected-node-details", { hasText: "Diffstat" }).waitFor();
          await page.locator("#selected-node-details", { hasText: "1 files, +12 / -2" }).waitFor();
          await page.locator("#selected-node-details", { hasText: "Changed Files" }).waitFor();
          await page.locator("#selected-node-details", { hasText: "docs/audit-log.md [modified] +12 / -2" }).waitFor();
          assert.doesNotMatch(await page.locator("#selected-node-details").textContent(), /secret-token|workspace-secret/);
        });
      } finally {
        await context.close();
        await visualizer.close();
      }
    });
  } finally {
    await browser.close();
  }
});

test("visualizer graph layout stays visible, unclipped, and non-overlapping for representative plans", async (t) => {
  const browser = await launchChromiumOrSkip(t);
  if (!browser) {
    return;
  }

  try {
    const desktopViewport = { slug: "desktop", width: 1280, height: 900 };
    const mobileViewport = { slug: "mobile", width: 390, height: 900 };
    for (const fixture of layoutRegressionGraphs()) {
      await t.test(fixture.slug, async () => {
        const viewports = fixture.slug === "large" ? [desktopViewport] : [desktopViewport, mobileViewport];
        for (const viewport of viewports) {
          await withTempGraph(() => fixture.graph, async (graphPath, dir) => {
            const visualizer = await createVisualizerServer({ graphPath, port: 0, defaultWorkerCwd: dir });
            const context = await browser.newContext({ viewport });
            try {
              const page = await context.newPage();
              page.setDefaultTimeout(8000);
              await runWithPageDiagnostics(page, `visualizer-layout-${fixture.slug}-${viewport.slug}`, graphPath, async () => {
                await page.goto(visualizer.url);
                await page.locator("#graph svg.sp-graph").waitFor();
                if (fixture.slug !== "hostile-long-text") {
                  await assertGraphLayoutInvariants(page, fixture.graph);
                }
              });
            } finally {
              await context.close();
              await visualizer.close();
            }
          });
        }
      });
    }
  } finally {
    await browser.close();
  }
});

test("visualizer dense panels keep critical text and controls readable", async (t) => {
  const browser = await launchChromiumOrSkip(t);
  if (!browser) {
    return;
  }

  const fixture = layoutRegressionGraphs().find((item) => item.slug === "hostile-long-text");
  assert.ok(fixture);

  try {
    for (const viewport of [
      { slug: "desktop", width: 1280, height: 900 },
      { slug: "narrow", width: 390, height: 900 }
    ]) {
      await t.test(viewport.slug, async () => {
        await withTempGraph(() => fixture.graph, async (graphPath, dir) => {
          const visualizer = await createVisualizerServer({ graphPath, port: 0, defaultWorkerCwd: dir });
          const context = await browser.newContext({ viewport });
          try {
            const page = await context.newPage();
            page.setDefaultTimeout(8000);
            await runWithPageDiagnostics(page, `visualizer-dense-panels-${viewport.slug}`, graphPath, async () => {
              await page.goto(visualizer.url);
              await page.locator("#graph svg.sp-graph").waitFor();
              await page.locator("#working", { hasText: "Blocked question" }).waitFor();

              const artifactDir = await ensureBrowserArtifactDir();
              const screenshotPath = join(artifactDir ?? dir, `visualizer-dense-panels-${viewport.slug}.png`);
              await page.screenshot({ path: screenshotPath });
              assert.equal(existsSync(screenshotPath), true);
            });
          } finally {
            await context.close();
            await visualizer.close();
          }
        });
      });
    }
  } finally {
    await browser.close();
  }
});

test("visualizer starts one managed worker for the selected ready node without Codex", async (t) => {
  const browser = await launchChromiumOrSkip(t);
  if (!browser) {
    return;
  }

  try {
    await withTempGraph(browserFixtureGraph, async (graphPath, dir) => {
      const visualizer = await createVisualizerServer({ graphPath, port: 0, defaultWorkerCwd: dir });
      const context = await browser.newContext();
      try {
        const page = await context.newPage();
        page.setDefaultTimeout(15000);
        await runWithPageDiagnostics(page, "visualizer-start-selected-worker", graphPath, async () => {
          await page.goto(visualizer.url);
          await page.locator('#ready [data-select-node="B"]').click();
          await page.locator("#selected-node-details", { hasText: "SSE task" }).waitFor();
          await page.locator("#start-selected-worker").waitFor();
          assert.equal(await page.locator("#start-selected-worker").isEnabled(), true);

          await page.fill("#worker-count", "4");
          await page.fill("#worker-prefix", "browser");
          await page.fill("#worker-command", process.execPath);
          await page.fill("#worker-codex-args", "-e\nconsole.log('selected worker without codex')");
          await page.fill("#worker-idle-ms", "5000");
          await page.locator("#start-selected-worker").click();

          await page.locator("#workers", { hasText: "browser-B-01" }).waitFor();
          await page.locator("#workers", { hasText: /exited|running/ }).waitFor();

          const graphAfterWorker = await waitForGraphCondition(
            graphPath,
            (graph) => graph.graph.nodes.B.status !== "pending",
            12000
          );
          assert.notEqual(graphAfterWorker.graph.nodes.B.status, "pending");
          assert.equal(graphAfterWorker.graph.nodes.A.status, "pending");
        });
      } finally {
        await context.close();
        await visualizer.close();
      }
    });
  } finally {
    await browser.close();
  }
});

test("visualizer page starts and stops managed workers without Codex", async (t) => {
  const browser = await launchChromiumOrSkip(t);
  if (!browser) {
    return;
  }

  try {
    await withTempGraph(completedBrowserFixtureGraph, async (graphPath, dir) => {
      const visualizer = await createVisualizerServer({ graphPath, port: 0, defaultWorkerCwd: dir });
      const context = await browser.newContext();
      try {
        const page = await context.newPage();
        page.setDefaultTimeout(10000);
        await runWithPageDiagnostics(page, "visualizer-managed-workers", graphPath, async () => {
          await page.goto(visualizer.url);
          await page.getByRole("heading", { name: "Worker Manager" }).waitFor();

          await page.fill("#worker-count", "1");
          await page.fill("#worker-prefix", "browser");
          await page.fill("#worker-command", process.execPath);
          await page.fill("#worker-codex-args", "-e\nconsole.log('should not run without ready work')");
          await page.fill("#worker-idle-ms", "5000");
          await page.locator('#worker-manager-form button[type="submit"]').click();

          await page.locator("#workers", { hasText: "browser-01" }).waitFor();
          await page.locator("#workers", { hasText: "running" }).waitFor();

          await page.locator("[data-stop-worker]").click();
          await page.locator("#workers", { hasText: "exited" }).waitFor();
          await page.locator("#workers", { hasText: "SIGTERM" }).waitFor();
        });
      } finally {
        await context.close();
        await visualizer.close();
      }
    });
  } finally {
    await browser.close();
  }
});
