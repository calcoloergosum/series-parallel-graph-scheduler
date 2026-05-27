#!/usr/bin/env node
// Compatibility wrapper. The renderer implementation lives in
// scripts/render-plan.ts and is emitted to dist/scripts/render-plan.js.
import { realpathSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
export * from "../dist/scripts/render-plan.js";
import { main } from "../dist/scripts/render-plan.js";
import { printCliError } from "../dist/scripts/cli-errors.js";

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
