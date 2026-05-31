import test from "node:test";

import { aggregateChildGitFootprints, assert, buildGraphGitFootprintSummary } from "./helpers/plan-scheduler-harness.mjs";

test("aggregateChildGitFootprints sums series child stats and de-duplicates file paths", () => {
  const result = aggregateChildGitFootprints({
    parentId: "SERIES",
    parentKind: "series",
    children: [
      {
        nodeId: "FIRST",
        gitFootprint: footprint([
          file("src/shared.ts", 2, 1),
          file("docs/first.md", 4, 0)
        ])
      },
      {
        nodeId: "SECOND",
        gitFootprint: footprint([
          file("src/shared.ts", 3, 2)
        ])
      }
    ],
    collectedAt: "2026-05-31T00:00:00.000Z"
  });

  assert.equal(result.source, "child-aggregate");
  assert.deepEqual(result.diffStat, {
    filesChanged: 2,
    additions: 9,
    deletions: 3,
    totalChanges: 12
  });
  assert.deepEqual(result.aggregation.duplicateFilePaths, ["src/shared.ts"]);
  assert.equal(result.aggregation.diffStatKind, "summed-child-stats");
  assert.deepEqual(result.files.map((item) => item.path), ["docs/first.md", "src/shared.ts"]);
  assert.deepEqual(result.files.find((item) => item.path === "src/shared.ts"), {
    path: "src/shared.ts",
    changeType: "modified",
    additions: 5,
    deletions: 3,
    totalChanges: 8,
    childIds: ["FIRST", "SECOND"]
  });
});

test("aggregateChildGitFootprints produces deterministic totals for parallel child order", () => {
  const left = { nodeId: "LEFT", gitFootprint: footprint([file("b.txt", 1, 0), file("same.txt", 2, 0)]) };
  const right = { nodeId: "RIGHT", gitFootprint: footprint([file("a.txt", 0, 1), file("same.txt", 1, 1)]) };

  const forward = aggregateChildGitFootprints({ parentId: "P", parentKind: "parallel", children: [left, right] });
  const reverse = aggregateChildGitFootprints({ parentId: "P", parentKind: "parallel", children: [right, left] });

  assert.deepEqual(reverse.diffStat, forward.diffStat);
  assert.deepEqual(reverse.aggregation.includedChildIds, forward.aggregation.includedChildIds);
  assert.deepEqual(reverse.aggregation.duplicateFilePaths, ["same.txt"]);
  assert.deepEqual(reverse.files.map((item) => item.path), ["a.txt", "b.txt", "same.txt"]);
});

test("aggregateChildGitFootprints accepts nested parent footprints as child inputs", () => {
  const nested = aggregateChildGitFootprints({
    parentId: "FANOUT",
    parentKind: "parallel",
    children: [
      { nodeId: "API", gitFootprint: footprint([file("api.ts", 10, 1)]) },
      { nodeId: "WEB", gitFootprint: footprint([file("web.ts", 5, 0)]) }
    ]
  });

  const result = aggregateChildGitFootprints({
    parentId: "ROOT_SERIES",
    parentKind: "series",
    children: [
      { nodeId: "FANOUT", gitFootprint: nested },
      { nodeId: "TAIL", gitFootprint: footprint([file("release.md", 1, 1)]) }
    ]
  });

  assert.deepEqual(result.diffStat, {
    filesChanged: 3,
    additions: 16,
    deletions: 2,
    totalChanges: 18
  });
  assert.deepEqual(result.aggregation.includedChildIds, ["FANOUT", "TAIL"]);
  assert.deepEqual(result.files.map((item) => item.path), ["api.ts", "release.md", "web.ts"]);
});

test("aggregateChildGitFootprints records missing child stats without blocking aggregation", () => {
  const result = aggregateChildGitFootprints({
    parentId: "P",
    parentKind: "parallel",
    children: [
      { nodeId: "WITH_STATS", outputRef: outputRef("refs/heads/with-stats", [file("kept.ts", 7, 0)]) },
      { nodeId: "NO_STATS", outputRef: { name: "refs/heads/no-stats", commit: "b".repeat(40) } }
    ]
  });

  assert.deepEqual(result.diffStat, {
    filesChanged: 1,
    additions: 7,
    deletions: 0,
    totalChanges: 7
  });
  assert.deepEqual(result.aggregation.includedChildIds, ["WITH_STATS"]);
  assert.deepEqual(result.aggregation.missingChildIds, ["NO_STATS"]);
});

test("aggregateChildGitFootprints combines stat-only and binary file metadata", () => {
  const result = aggregateChildGitFootprints({
    parentId: "ROOT",
    parentKind: "series",
    baseRef: { name: "refs/remotes/origin/main", commit: "0".repeat(40) },
    headRef: { name: "refs/heads/spg/integration/ROOT/run", commit: "f".repeat(40) },
    children: [
      {
        nodeId: "STAT_ONLY",
        outputRef: {
          name: "refs/heads/stat-only",
          commit: "1".repeat(40),
          diffStat: {
            filesChanged: 2,
            insertions: 4,
            deletions: 1,
            totalChanges: 5,
            binaryFiles: 1
          }
        }
      },
      {
        nodeId: "BINARY_FILE",
        gitFootprint: {
          source: "git-diff",
          files: [
            {
              path: "assets/logo.png",
              changeType: "modified",
              insertions: null,
              deletions: null,
              totalChanges: null,
              binary: true
            }
          ]
        }
      }
    ]
  });

  assert.equal(result.commit, "f".repeat(40));
  assert.deepEqual(result.diffStat, {
    filesChanged: 3,
    additions: 4,
    deletions: 1,
    totalChanges: 5,
    binaryFiles: 2
  });
  assert.deepEqual(result.files, [
    {
      path: "assets/logo.png",
      changeType: "modified",
      additions: null,
      deletions: null,
      totalChanges: null,
      binary: true,
      childIds: ["BINARY_FILE"]
    }
  ]);
  assert.deepEqual(result.aggregation.includedChildIds, ["BINARY_FILE", "STAT_ONLY"]);
  assert.equal(result.aggregation.filesChangedKind, "unique-file-paths-with-stat-only-sum");
});

test("buildGraphGitFootprintSummary counts nested series parent footprints once", () => {
  const graph = graphWithNodes({
    ROOT: { title: "Root", kind: "series", status: "done", children: ["SETUP", "NESTED"] },
    SETUP: { title: "Setup", kind: "task", status: "done", gitFootprint: footprint([file("setup.ts", 1, 0)]) },
    NESTED: {
      title: "Nested series",
      kind: "series",
      status: "done",
      children: ["FIRST", "SECOND"],
      gitFootprint: aggregateFootprint("NESTED", "series", ["FIRST", "SECOND"], [
        file("nested-final.ts", 3, 1),
        file("shared.ts", 2, 0)
      ])
    },
    FIRST: { title: "First", kind: "task", status: "done", gitFootprint: footprint([file("shared.ts", 20, 0)]) },
    SECOND: { title: "Second", kind: "task", status: "done", gitFootprint: footprint([file("nested-final.ts", 30, 10)]) }
  });

  const summary = buildGraphGitFootprintSummary(graph);

  assert.deepEqual(summary.diffStat, {
    filesChanged: 3,
    additions: 6,
    deletions: 1,
    totalChanges: 7
  });
  assert.deepEqual(summary.changedFiles.map((item) => item.path), ["nested-final.ts", "setup.ts", "shared.ts"]);
  assert.deepEqual(summary.nodes.map((node) => node.nodeId), ["FIRST", "NESTED", "SECOND", "SETUP"]);
});

test("buildGraphGitFootprintSummary counts nested parallel parent footprints once", () => {
  const graph = graphWithNodes({
    ROOT: { title: "Root", kind: "parallel", status: "done", children: ["LEFT", "FANOUT"] },
    LEFT: { title: "Left", kind: "task", status: "done", gitFootprint: footprint([file("left.ts", 1, 0)]) },
    FANOUT: {
      title: "Fanout",
      kind: "parallel",
      status: "done",
      children: ["API", "WEB"],
      gitFootprint: aggregateFootprint("FANOUT", "parallel", ["API", "WEB"], [
        file("api.ts", 4, 1),
        file("web.ts", 5, 0)
      ])
    },
    API: { title: "API", kind: "task", status: "done", gitFootprint: footprint([file("api.ts", 40, 10)]) },
    WEB: { title: "Web", kind: "task", status: "done", gitFootprint: footprint([file("web.ts", 50, 0)]) }
  });

  const summary = buildGraphGitFootprintSummary(graph);

  assert.deepEqual(summary.diffStat, {
    filesChanged: 3,
    additions: 10,
    deletions: 1,
    totalChanges: 11
  });
  assert.deepEqual(summary.changedFiles.map((item) => item.path), ["api.ts", "left.ts", "web.ts"]);
  assert.deepEqual(summary.nodes.map((node) => node.nodeId), ["API", "FANOUT", "LEFT", "WEB"]);
});

test("buildGraphGitFootprintSummary prefers a real parent diffstat over children and childAggregate", () => {
  const graph = graphWithNodes({
    ROOT: {
      title: "Root",
      kind: "series",
      status: "done",
      children: ["A", "B"],
      gitFootprint: {
        ...footprint([file("net.ts", 2, 1)]),
        childAggregate: aggregateFootprint("ROOT", "series", ["A", "B"], [
          file("a.ts", 20, 0),
          file("b.ts", 20, 0)
        ])
      }
    },
    A: { title: "A", kind: "task", status: "done", gitFootprint: footprint([file("a.ts", 20, 0)]) },
    B: { title: "B", kind: "task", status: "done", gitFootprint: footprint([file("b.ts", 20, 0)]) }
  });

  const summary = buildGraphGitFootprintSummary(graph);

  assert.deepEqual(summary.diffStat, {
    filesChanged: 1,
    additions: 2,
    deletions: 1,
    totalChanges: 3
  });
  assert.deepEqual(summary.changedFiles.map((item) => item.path), ["net.ts"]);
  assert.deepEqual(summary.nodes.map((node) => node.nodeId), ["A", "B", "ROOT"]);
});

test("buildGraphGitFootprintSummary descends through missing parent stats and tolerates commit-only leaves", () => {
  const graph = graphWithNodes({
    ROOT: { title: "Root", kind: "series", status: "done", children: ["HAS_STATS", "MISSING_PARENT", "COMMIT_ONLY"] },
    HAS_STATS: { title: "Has stats", kind: "task", status: "done", outputRef: outputRef("refs/heads/has-stats", [file("kept.ts", 7, 0)]) },
    MISSING_PARENT: {
      title: "Missing parent stats",
      kind: "parallel",
      status: "done",
      children: ["NESTED_WITH_STATS", "NESTED_MISSING"],
      outputRef: { name: "refs/heads/missing-parent", commit: "b".repeat(40) }
    },
    NESTED_WITH_STATS: { title: "Nested with stats", kind: "task", status: "done", gitFootprint: footprint([file("nested.ts", 3, 2)]) },
    NESTED_MISSING: { title: "Nested missing", kind: "task", status: "done", outputRef: { name: "refs/heads/nested-missing", commit: "c".repeat(40) } },
    COMMIT_ONLY: { title: "Commit only", kind: "task", status: "done", outputRef: { name: "refs/heads/commit-only", commit: "d".repeat(40) } }
  });

  const summary = buildGraphGitFootprintSummary(graph);

  assert.deepEqual(summary.diffStat, {
    filesChanged: 2,
    additions: 10,
    deletions: 2,
    totalChanges: 12
  });
  assert.deepEqual(summary.changedFiles.map((item) => item.path), ["kept.ts", "nested.ts"]);
  assert.deepEqual(summary.nodes.map((node) => node.nodeId), [
    "COMMIT_ONLY",
    "HAS_STATS",
    "MISSING_PARENT",
    "NESTED_MISSING",
    "NESTED_WITH_STATS"
  ]);
});

function footprint(files) {
  return {
    source: "git-diff",
    diffStat: diffStat(files),
    files
  };
}

function aggregateFootprint(parentId, parentKind, includedChildIds, files) {
  return {
    source: "child-aggregate",
    diffStat: diffStat(files),
    files,
    aggregation: {
      source: "child-footprints",
      parentId,
      parentKind,
      childCount: includedChildIds.length,
      includedChildIds,
      missingChildIds: [],
      duplicateFilePaths: [],
      diffStatKind: "summed-child-stats",
      filesChangedKind: "unique-file-paths-with-stat-only-sum",
      fileMergeRule: "sum-line-counts-by-path"
    }
  };
}

function graphWithNodes(nodes) {
  return {
    graphVersion: 1,
    graph: {
      root: "ROOT",
      nodes
    }
  };
}

function outputRef(name, files) {
  return {
    name,
    commit: "a".repeat(40),
    diffStat: diffStat(files),
    files
  };
}

function file(path, additions, deletions) {
  return {
    path,
    changeType: "modified",
    additions,
    deletions,
    totalChanges: additions + deletions
  };
}

function diffStat(files) {
  return {
    filesChanged: files.length,
    additions: files.reduce((sum, file) => sum + file.additions, 0),
    deletions: files.reduce((sum, file) => sum + file.deletions, 0),
    totalChanges: files.reduce((sum, file) => sum + file.totalChanges, 0)
  };
}
