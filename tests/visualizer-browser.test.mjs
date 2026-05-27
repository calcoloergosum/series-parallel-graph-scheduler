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
  readGraph
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

function layoutRegressionGraphs() {
  const seriesIds = Array.from({ length: 18 }, (_, index) => `L${index + 1}`);
  const wideIds = Array.from({ length: 12 }, (_, index) => `W${index + 1}`);

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

test("visualizer graph layout stays visible, unclipped, and non-overlapping for representative plans", async (t) => {
  const browser = await launchChromiumOrSkip(t);
  if (!browser) {
    return;
  }

  try {
    for (const fixture of layoutRegressionGraphs()) {
      await t.test(fixture.slug, async () => {
        await withTempGraph(() => fixture.graph, async (graphPath, dir) => {
          const visualizer = await createVisualizerServer({ graphPath, port: 0, defaultWorkerCwd: dir });
          const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
          try {
            const page = await context.newPage();
            page.setDefaultTimeout(8000);
            await runWithPageDiagnostics(page, `visualizer-layout-${fixture.slug}`, graphPath, async () => {
              await page.goto(visualizer.url);
              await page.locator("#graph svg.sp-graph").waitFor();
              await assertGraphLayoutInvariants(page, fixture.graph);
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
