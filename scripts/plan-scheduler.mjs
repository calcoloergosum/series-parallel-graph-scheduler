#!/usr/bin/env node
// Compatibility wrapper. The scheduler implementation lives in
// scripts/plan-scheduler.ts and is emitted to dist/scripts/plan-scheduler.js.
import { realpathSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
export * from "../dist/scripts/plan-scheduler.js";
import { main } from "../dist/scripts/plan-scheduler.js";
import { printCliError } from "../dist/scripts/plan-scheduler.js";

function isDirectEntrypoint() {
  if (!process.argv[1]) {
    return false;
  }
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
  } catch {
    return import.meta.url === pathToFileURL(process.argv[1]).href;
  }
}

if (isDirectEntrypoint()) {
  main().catch((error) => {
    printCliError(error, process.env);
    process.exitCode = 1;
  });
}
