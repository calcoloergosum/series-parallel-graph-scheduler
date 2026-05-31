import type {
  GitDiffStatMetadata,
  GitFileChangeType,
  GitFileFootprintMetadata,
  GitFootprintNodeSummary,
  GitFootprintSummary,
  GitRefFootprintMetadata,
  GraphNode,
  IsoDateString,
  NodeGitFootprintMetadata,
  NodeId,
  NodeKind,
  NodeOutputRefMetadata,
  PlanGraphFile
} from "./contracts.js";

export interface ChildGitFootprintInput {
  nodeId: NodeId;
  gitFootprint?: NodeGitFootprintMetadata;
  outputRef?: NodeOutputRefMetadata;
}

export interface AggregateChildGitFootprintsOptions {
  parentId?: NodeId;
  parentKind?: NodeKind;
  children: readonly ChildGitFootprintInput[];
  baseRef?: GitRefFootprintMetadata;
  headRef?: GitRefFootprintMetadata;
  collectedAt?: IsoDateString;
}

export function aggregateChildGitFootprints({
  parentId,
  parentKind,
  children,
  baseRef,
  headRef,
  collectedAt
}: AggregateChildGitFootprintsOptions): NodeGitFootprintMetadata | undefined {
  const includedChildIds: NodeId[] = [];
  const missingChildIds: NodeId[] = [];
  const filesByPath = new Map<string, MutableFileAggregate>();
  const duplicateFilePaths = new Set<string>();
  let additions = 0;
  let deletions = 0;
  let totalChanges = 0;
  let statOnlyFilesChanged = 0;
  let binaryFiles = 0;

  for (const child of children) {
    const footprint = child.gitFootprint || gitFootprintFromOutputRef(child.outputRef);
    const stat = childDiffStat(footprint);
    const files = footprint?.files || [];
    if (!stat && files.length === 0) {
      missingChildIds.push(child.nodeId);
      continue;
    }

    includedChildIds.push(child.nodeId);
    if (stat) {
      additions += diffStatAdditions(stat);
      deletions += stat.deletions;
      totalChanges += stat.totalChanges;
      binaryFiles += stat.binaryFiles || 0;
      if (files.length === 0) {
        statOnlyFilesChanged += stat.filesChanged;
      }
    }

    for (const file of files) {
      const existing = filesByPath.get(file.path);
      if (existing) {
        duplicateFilePaths.add(file.path);
        mergeFileAggregate(existing, file, child.nodeId);
      } else {
        filesByPath.set(file.path, createFileAggregate(file, child.nodeId));
      }
    }
  }

  if (includedChildIds.length === 0) {
    return undefined;
  }

  const files = Array.from(filesByPath.values())
    .sort((left, right) => left.path.localeCompare(right.path))
    .map(finalizeFileAggregate);
  const sortedIncludedChildIds = [...includedChildIds].sort();
  const sortedMissingChildIds = [...missingChildIds].sort();
  const sortedDuplicateFilePaths = Array.from(duplicateFilePaths).sort();
  const diffStat: GitDiffStatMetadata = {
    filesChanged: files.length + statOnlyFilesChanged,
    additions,
    deletions,
    totalChanges,
    ...(binaryFiles > 0 ? { binaryFiles } : {})
  };

  return {
    source: "child-aggregate",
    ...(baseRef ? { baseRef } : {}),
    ...(headRef ? { headRef, commit: headRef.commit } : {}),
    diffStat,
    files,
    aggregation: {
      source: "child-footprints",
      ...(parentId ? { parentId } : {}),
      ...(parentKind ? { parentKind } : {}),
      childCount: children.length,
      includedChildIds: sortedIncludedChildIds,
      missingChildIds: sortedMissingChildIds,
      duplicateFilePaths: sortedDuplicateFilePaths,
      diffStatKind: "summed-child-stats",
      filesChangedKind: "unique-file-paths-with-stat-only-sum",
      fileMergeRule: "sum-line-counts-by-path"
    },
    ...(collectedAt ? { collectedAt } : {})
  };
}

export function gitFootprintFromNode(node: Pick<GraphNode, "baseRef" | "gitFootprint" | "outputRef">): NodeGitFootprintMetadata | undefined {
  if (node.gitFootprint) {
    return node.gitFootprint;
  }
  return gitFootprintFromOutputRef(node.outputRef, node.baseRef);
}

export function gitFootprintFromOutputRef(
  outputRef: NodeOutputRefMetadata | undefined,
  baseRef?: GitRefFootprintMetadata
): NodeGitFootprintMetadata | undefined {
  if (!outputRef?.commit && !outputRef?.diffStat && !outputRef?.files?.length && !outputRef?.collectedAt) {
    return undefined;
  }
  return {
    source: "git-diff",
    ...(baseRef ? { baseRef: refFootprint(baseRef) } : {}),
    headRef: {
      name: outputRef.name,
      commit: outputRef.commit
    },
    commit: outputRef.commit,
    ...(outputRef.diffStat ? { diffStat: outputRef.diffStat } : {}),
    ...(outputRef.files ? { files: outputRef.files } : {}),
    ...(outputRef.collectedAt ? { collectedAt: outputRef.collectedAt } : {})
  };
}

export function buildGraphGitFootprintSummary(graph: PlanGraphFile): GitFootprintSummary | undefined {
  const nodes = graph.graph?.nodes || {};
  const children = Object.entries(nodes)
    .sort(([leftId], [rightId]) => leftId.localeCompare(rightId))
    .map(([nodeId, node]) => ({
      nodeId,
      gitFootprint: gitFootprintFromNode(node),
      outputRef: node.outputRef
    }));
  const nodeSummaries = children
    .map((child) => {
      const node = graph.graph.nodes[child.nodeId];
      const footprint = child.gitFootprint;
      return footprint ? footprintNodeSummary(child.nodeId, node, footprint) : undefined;
    })
    .filter((summary): summary is GitFootprintNodeSummary => Boolean(summary));

  if (nodeSummaries.length === 0) {
    return undefined;
  }

  const aggregateChildren = graphGitFootprintAggregationChildren(graph);
  const aggregate = aggregateChildGitFootprints({ children: aggregateChildren });
  return {
    nodes: nodeSummaries,
    refs: {
      baseRefs: uniqueRefs(nodeSummaries.map((node) => node.baseRef)),
      headRefs: uniqueRefs(nodeSummaries.map((node) => node.headRef)),
      commits: uniqueStrings(nodeSummaries.map((node) => node.commit))
    },
    diffStat: aggregate?.diffStat || zeroDiffStat(),
    changedFiles: aggregate?.files || []
  };
}

function graphGitFootprintAggregationChildren(graph: PlanGraphFile): ChildGitFootprintInput[] {
  const nodes = graph.graph?.nodes || {};
  const parentIds = new Set<NodeId>();
  for (const node of Object.values(nodes)) {
    for (const childId of node.children || []) {
      parentIds.add(childId);
    }
  }

  const sortedNodeIds = Object.keys(nodes).sort();
  const rootIds = [
    ...(graph.graph?.root && nodes[graph.graph.root] ? [graph.graph.root] : []),
    ...sortedNodeIds.filter((nodeId) => nodeId !== graph.graph?.root && !parentIds.has(nodeId))
  ];
  const visited = new Set<NodeId>();
  const children: ChildGitFootprintInput[] = [];

  for (const rootId of rootIds) {
    collectGraphGitFootprintAggregationChildren(nodes, rootId, visited, children);
  }
  for (const nodeId of sortedNodeIds) {
    collectGraphGitFootprintAggregationChildren(nodes, nodeId, visited, children);
  }

  return children;
}

function collectGraphGitFootprintAggregationChildren(
  nodes: Record<NodeId, GraphNode>,
  nodeId: NodeId,
  visited: Set<NodeId>,
  children: ChildGitFootprintInput[]
): void {
  if (visited.has(nodeId)) {
    return;
  }
  visited.add(nodeId);

  const node = nodes[nodeId];
  if (!node) {
    return;
  }

  const footprint = gitFootprintFromNode(node);
  if (hasMeasurableGitFootprint(footprint)) {
    children.push({
      nodeId,
      gitFootprint: footprint,
      outputRef: node.outputRef
    });
    markGraphGitFootprintDescendantsVisited(nodes, nodeId, visited);
    return;
  }

  const childIds = node.children || [];
  if (childIds.length > 0) {
    for (const childId of childIds) {
      collectGraphGitFootprintAggregationChildren(nodes, childId, visited, children);
    }
    return;
  }

  if (footprint) {
    children.push({
      nodeId,
      gitFootprint: footprint,
      outputRef: node.outputRef
    });
  }
}

function markGraphGitFootprintDescendantsVisited(
  nodes: Record<NodeId, GraphNode>,
  nodeId: NodeId,
  visited: Set<NodeId>
): void {
  const node = nodes[nodeId];
  if (!node) {
    return;
  }
  for (const childId of node.children || []) {
    if (visited.has(childId)) {
      continue;
    }
    visited.add(childId);
    markGraphGitFootprintDescendantsVisited(nodes, childId, visited);
  }
}

function hasMeasurableGitFootprint(footprint: NodeGitFootprintMetadata | undefined): boolean {
  return Boolean(footprint?.diffStat || footprint?.files?.length);
}

function footprintNodeSummary(
  nodeId: NodeId,
  node: GraphNode,
  footprint: NodeGitFootprintMetadata
): GitFootprintNodeSummary {
  return {
    nodeId,
    title: node.title,
    kind: node.kind || "task",
    status: node.status || "pending",
    source: footprint.source,
    baseRef: footprint.baseRef,
    headRef: footprint.headRef,
    branch: footprint.branch,
    commit: footprint.commit || footprint.headRef?.commit,
    diffStat: footprint.diffStat,
    changedFiles: footprint.files || [],
    collectedAt: footprint.collectedAt
  };
}

function uniqueRefs(refs: Array<GitRefFootprintMetadata | undefined>): GitRefFootprintMetadata[] {
  const seen = new Set<string>();
  const unique: GitRefFootprintMetadata[] = [];
  for (const ref of refs) {
    if (!ref?.name && !ref?.commit) {
      continue;
    }
    const key = `${ref.name || ""}\0${ref.commit || ""}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    unique.push(refFootprint(ref));
  }
  return unique.sort((left, right) => String(left.name || "").localeCompare(String(right.name || "")) || String(left.commit || "").localeCompare(String(right.commit || "")));
}

function refFootprint(ref: GitRefFootprintMetadata): GitRefFootprintMetadata {
  return {
    ...(ref.name ? { name: ref.name } : {}),
    ...(ref.commit ? { commit: ref.commit } : {})
  };
}

function uniqueStrings(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))].sort();
}

function zeroDiffStat(): GitDiffStatMetadata {
  return {
    filesChanged: 0,
    additions: 0,
    deletions: 0,
    totalChanges: 0
  };
}

function childDiffStat(footprint: NodeGitFootprintMetadata | undefined): GitDiffStatMetadata | undefined {
  if (!footprint) {
    return undefined;
  }
  if (footprint.diffStat) {
    return footprint.diffStat;
  }
  if (!footprint.files?.length) {
    return undefined;
  }
  let filesChanged = 0;
  let additions = 0;
  let deletions = 0;
  let totalChanges = 0;
  let binaryFiles = 0;
  for (const file of footprint.files) {
    filesChanged += 1;
    additions += file.additions ?? 0;
    deletions += file.deletions ?? 0;
    totalChanges += file.totalChanges ?? 0;
    if (file.binary) {
      binaryFiles += 1;
    }
  }
  return {
    filesChanged,
    additions,
    deletions,
    totalChanges,
    ...(binaryFiles > 0 ? { binaryFiles } : {})
  };
}

interface MutableFileAggregate {
  path: string;
  oldPaths: Set<string>;
  changeTypes: Set<string>;
  additions: number | null;
  deletions: number | null;
  totalChanges: number | null;
  binary: boolean;
  childIds: NodeId[];
}

function createFileAggregate(file: GitFileFootprintMetadata, childId: NodeId): MutableFileAggregate {
  return {
    path: file.path,
    oldPaths: new Set(file.oldPath ? [file.oldPath] : []),
    changeTypes: new Set(file.changeType ? [file.changeType] : []),
    additions: fileAdditions(file),
    deletions: file.deletions,
    totalChanges: file.totalChanges,
    binary: Boolean(file.binary),
    childIds: [childId]
  };
}

function mergeFileAggregate(target: MutableFileAggregate, file: GitFileFootprintMetadata, childId: NodeId): void {
  if (file.oldPath) {
    target.oldPaths.add(file.oldPath);
  }
  if (file.changeType) {
    target.changeTypes.add(file.changeType);
  }
  target.additions = sumNullable(target.additions, fileAdditions(file));
  target.deletions = sumNullable(target.deletions, file.deletions);
  target.totalChanges = sumNullable(target.totalChanges, file.totalChanges);
  target.binary = target.binary || Boolean(file.binary);
  if (!target.childIds.includes(childId)) {
    target.childIds.push(childId);
  }
}

function finalizeFileAggregate(file: MutableFileAggregate): GitFileFootprintMetadata {
  const oldPaths = Array.from(file.oldPaths).sort();
  const changeTypes = Array.from(file.changeTypes).sort();
  const childIds = [...file.childIds].sort();
  return {
    path: file.path,
    ...(oldPaths.length === 1 ? { oldPath: oldPaths[0] } : {}),
    ...(oldPaths.length > 1 ? { oldPaths } : {}),
    ...(changeTypes.length === 1 ? { changeType: changeTypes[0] as GitFileChangeType } : {}),
    ...(changeTypes.length > 1 ? { changeTypes } : {}),
    additions: file.additions,
    deletions: file.deletions,
    totalChanges: file.totalChanges,
    ...(file.binary ? { binary: true } : {}),
    childIds
  };
}

function sumNullable(left: number | null, right: number | null): number | null {
  return left === null || right === null ? null : left + right;
}

function diffStatAdditions(stat: GitDiffStatMetadata): number {
  return stat.additions ?? stat.insertions ?? 0;
}

function fileAdditions(file: GitFileFootprintMetadata): number | null {
  return file.additions ?? file.insertions ?? null;
}
