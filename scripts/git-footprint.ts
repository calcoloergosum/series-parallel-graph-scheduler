import type {
  GitDiffStatMetadata,
  GitFileChangeType,
  GitFileFootprintMetadata,
  GitRefFootprintMetadata,
  IsoDateString,
  NodeGitFootprintMetadata,
  NodeId,
  NodeKind,
  NodeOutputRefMetadata
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
    const footprint = child.gitFootprint || footprintFromOutputRef(child.outputRef);
    const stat = childDiffStat(footprint);
    const files = footprint?.files || [];
    if (!stat && files.length === 0) {
      missingChildIds.push(child.nodeId);
      continue;
    }

    includedChildIds.push(child.nodeId);
    if (stat) {
      additions += stat.additions;
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

function footprintFromOutputRef(outputRef: NodeOutputRefMetadata | undefined): NodeGitFootprintMetadata | undefined {
  if (!outputRef?.diffStat && !outputRef?.files?.length) {
    return undefined;
  }
  return {
    source: "git-diff",
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
    additions: file.additions,
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
  target.additions = sumNullable(target.additions, file.additions);
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
