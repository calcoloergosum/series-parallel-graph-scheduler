#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, renameSync, rmSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = fileURLToPath(new URL("..", import.meta.url));
const distDir = join(rootDir, "dist");
const unique = `${process.pid}-${Date.now()}`;
const tempDistDir = join(rootDir, `.dist-build-${unique}`);
const backupDistDir = join(rootDir, `.dist-previous-${unique}`);
const tscBin = join(rootDir, "node_modules", "typescript", "bin", "tsc");

rmSync(tempDistDir, { recursive: true, force: true });
rmSync(backupDistDir, { recursive: true, force: true });

try {
  runTsc();
  cpSync(join(rootDir, "prompts"), join(tempDistDir, "prompts"), { recursive: true, force: true });
  for (const file of ["scripts/plan-scheduler.js", "scripts/render-plan.js"]) {
    chmodSync(join(tempDistDir, file), 0o755);
  }

  if (existsSync(distDir)) {
    renameSync(distDir, backupDistDir);
  }
  try {
    renameSync(tempDistDir, distDir);
  } catch (error) {
    if (existsSync(backupDistDir) && !existsSync(distDir)) {
      renameSync(backupDistDir, distDir);
    }
    throw error;
  }
  rmSync(backupDistDir, { recursive: true, force: true });
} finally {
  rmSync(tempDistDir, { recursive: true, force: true });
  rmSync(backupDistDir, { recursive: true, force: true });
}

function runTsc() {
  const result = spawnSync(process.execPath, [tscBin, "-p", "tsconfig.json", "--outDir", tempDistDir], {
    cwd: rootDir,
    stdio: "inherit"
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}
