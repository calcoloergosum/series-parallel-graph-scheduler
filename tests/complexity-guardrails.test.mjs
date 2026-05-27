import test from "node:test";
import { assert, execFileAsync, fileURLToPath, originalBuiltScriptUrl } from "./helpers/plan-scheduler-harness.mjs";

test("complexity guardrails report advisory metrics without urgent failures", async () => {
  const scriptPath = fileURLToPath(originalBuiltScriptUrl("complexity-guardrails"));
  const { stdout, stderr } = await execFileAsync(process.execPath, [scriptPath]);

  assert.equal(stderr, "");
  assert.match(stdout, /# Complexity Guardrails/);
  assert.match(stdout, /Guardrail output is advisory unless an urgent threshold is crossed\./);
  assert.match(stdout, /scripts\/node-mutations\.ts/);
  assert.match(stdout, /Docs snapshot: current/);
  assert.match(stdout, /Urgent failures: 0/);
});

test("complexity guardrails expose machine-readable JSON", async () => {
  const scriptPath = fileURLToPath(originalBuiltScriptUrl("complexity-guardrails"));
  const { stdout } = await execFileAsync(process.execPath, [scriptPath, "--json"]);
  const report = JSON.parse(stdout);

  assert.equal(report.docsSnapshotCurrent, true);
  assert.equal(report.urgentFailures.length, 0);
  assert.ok(report.files.some((file) => file.path === "scripts/node-mutations.ts"));
  assert.ok(report.exportHotSpots.some((file) => file.path === "scripts/contracts.ts"));
  assert.ok(report.testSuites.some((file) => file.path === "tests/worker-runtime.test.mjs"));
});
