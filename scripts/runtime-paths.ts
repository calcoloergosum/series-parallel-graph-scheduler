import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface RuntimePaths {
  scriptDir: string;
  scriptParentDir: string;
  rootDir: string;
  isBuiltOutput: boolean;
}

export function runtimePathsFromModuleUrl(moduleUrl: string): RuntimePaths {
  const scriptDir = dirname(fileURLToPath(moduleUrl));
  const scriptParentDir = resolve(scriptDir, "..");
  const isBuiltOutput = basename(scriptParentDir) === "dist";
  const rootDir = isBuiltOutput ? resolve(scriptParentDir, "..") : scriptParentDir;
  return {
    scriptDir,
    scriptParentDir,
    rootDir,
    isBuiltOutput
  };
}
