#!/usr/bin/env node
// Compatibility wrapper. The renderer implementation lives in
// scripts/render-plan.ts and is emitted to dist/scripts/render-plan.js.
await import("../dist/scripts/render-plan.js");
