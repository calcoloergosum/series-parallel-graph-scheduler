import test from "node:test";
import { assert, builtBinPath, execFileAsync, fileURLToPath, fixtureGraph, join, mkdtemp, packageDefaultGraphPath, packageJson, readFile, rm, tmpdir, writeFile } from "./helpers/plan-scheduler-harness.mjs";

test("package npm scripts and bins target migrated build output", () => {
  for (const command of ["ready", "summary", "serve", "worker"]) {
    assert.match(packageJson.scripts[command], new RegExp(`node dist/scripts/plan-scheduler\\.js ${command}`));
  }

  assert.match(packageJson.scripts.render, /node dist\/scripts\/render-plan\.js/);
  assert.match(packageJson.scripts["schema:graph"], /node dist\/scripts\/generate-graph-schema\.js/);
  assert.match(packageJson.scripts["smoke:migration"], /node scripts\/migration-smoke\.mjs/);
  assert.match(packageJson.scripts["smoke:package"], /node scripts\/package-smoke\.mjs/);
  assert.match(packageJson.scripts["audit:dependencies"], /node scripts\/dependency-audit\.mjs && npm audit --audit-level=moderate/);
  assert.match(packageJson.scripts.guardrails, /node dist\/scripts\/complexity-guardrails\.js/);
  assert.match(packageJson.scripts["guardrails:update"], /node dist\/scripts\/complexity-guardrails\.js --update-docs/);
  assert.match(packageJson.scripts["release:check"], /npm run guardrails && npm run audit:dependencies && npm run smoke:package/);
  assert.match(packageJson.scripts.test, /npm run build/);
  assert.match(packageJson.scripts.test, /tests\/cli-goldens\.test\.mjs/);
  assert.match(packageJson.scripts.test, /tests\/worker-runtime\.test\.mjs/);
  assert.match(packageJson.scripts.test, /tests\/regressions\.test\.mjs/);
  assert.match(packageJson.scripts.test, /tests\/doc-examples\.test\.mjs/);
  assert.match(packageJson.scripts.test, /tests\/complexity-guardrails\.test\.mjs/);
  assert.match(packageJson.scripts["coverage:core"], /c8 .*tests\/scheduler-mutations\.test\.mjs/);
  assert.match(packageJson.scripts["coverage:core"], /tests\/visualizer-renderer\.test\.mjs/);
  assert.match(packageJson.scripts["coverage:core"], /tests\/regressions\.test\.mjs/);
  assert.match(packageJson.scripts["coverage:core"], /tests\/doc-examples\.test\.mjs/);
  assert.doesNotMatch(packageJson.scripts["coverage:core"], /tests\/plan-scheduler\.test\.mjs/);
  assert.match(packageJson.scripts["test:visualizer"], /tests\/visualizer-browser\.test\.mjs/);
  assert.match(packageJson.scripts["stress:deterministic"], /node dist\/scripts\/stress-concurrency\.js --iterations 100/);
  assert.match(packageJson.scripts["benchmark:lock-contention"], /node dist\/scripts\/benchmark-lock-contention\.js/);
  assert.equal(packageJson.bin["spg-scheduler"], "./dist/scripts/plan-scheduler.js");
  assert.equal(packageJson.bin["spg-render-plan"], "./dist/scripts/render-plan.js");
  assert.ok(packageJson.files.includes("CHANGELOG.md"));
  assert.ok(packageJson.files.includes("schemas/"));
  assert.ok(packageJson.files.includes("examples/"));
});

test("built shared graph IO defaults resolve to package graph path", () => {
  assert.equal(packageDefaultGraphPath, fileURLToPath(new URL("../plan.graph.json", import.meta.url)));
});

test("built package bin entry points smoke test scheduler and renderer CLIs", async () => {
  const schedulerBinPath = builtBinPath("spg-scheduler");
  const rendererBinPath = builtBinPath("spg-render-plan");
  const help = await execFileAsync(process.execPath, [schedulerBinPath, "help"]);
  assert.match(help.stdout, /node scripts\/plan-scheduler\.mjs ready/);

  const dir = await mkdtemp(join(tmpdir(), "plan-bin-smoke-"));
  const graphPath = join(dir, "bin.graph.json");
  const outputPath = join(dir, "bin.html");
  const graph = fixtureGraph();
  graph.document = {
    pageTitle: "Built Bin Smoke",
    intro: ["Renderer smoke"],
    sections: [{ heading: "Smoke", paragraphs: ["Built renderer CLI works."] }]
  };
  await writeFile(graphPath, `${JSON.stringify(graph, null, 2)}\n`, "utf8");

  try {
    const ready = await execFileAsync(process.execPath, [schedulerBinPath, "ready", "--graph", graphPath]);
    assert.deepEqual(JSON.parse(ready.stdout).map((node) => node.id), ["A"]);

    await execFileAsync(process.execPath, [rendererBinPath, "--graph", graphPath, "--output", outputPath]);
    assert.match(await readFile(outputPath, "utf8"), /Built Bin Smoke/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
