#!/usr/bin/env node
// Compatibility wrapper. The scheduler implementation lives in
// scripts/plan-scheduler.ts and is emitted to dist/scripts/plan-scheduler.js.
import { pathToFileURL } from "node:url";
export * from "../dist/scripts/plan-scheduler.js";
import { main } from "../dist/scripts/plan-scheduler.js";

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack || error.message : String(error));
    process.exitCode = 1;
  });
}
