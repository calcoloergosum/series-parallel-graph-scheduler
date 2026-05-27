# Lock Strategy Decision

Status: accepted for implementation in `TEN11`

Date: 2026-05-27

## Context

Scheduler mutations update one JSON graph file and then regenerate derived HTML. Only one process may perform a graph mutation at a time, otherwise two workers can claim the same node, overwrite each other's graph changes, or render HTML from a graph version that is no longer current.

The current lock in `scripts/graph-io.ts` uses `mkdir(<graph>.lock)` as the acquisition primitive, retries until a timeout, writes diagnostic metadata, treats an old lock directory `mtime` as stale, removes stale lock directories with `rm -r`, and removes the lock directory in `finally`.

Atomic `mkdir` is the right base primitive for a small cross-process lock on local macOS and Linux filesystems, but the current stale cleanup is too weak under contention.

## Options Considered

### Keep current implementation unchanged

- Correctness: Reject. Atomic acquisition is sound, but stale cleanup can delete another process's live lock.
- Portability: Works on local macOS and Linux filesystems when locks do not go stale.
- Failure modes: A slow or paused owner can be declared stale; later cleanup can remove a newer owner lock.
- Maintenance cost: Lowest, but leaves known concurrency bugs.
- Dependency risk: None.

### Add `proper-lockfile`

- Correctness: Strong option. It also uses atomic `mkdir`, probes filesystem `mtime` precision, refreshes lock `mtime` while held, supports stale detection, retries, release functions, and compromised-lock callbacks.
- Portability: Designed for local and network filesystems that provide atomic `mkdir` and usable `mtime`.
- Failure modes: Detects missed heartbeat updates, but still cannot fully protect against manual lock removal or mixed stale/update settings across callers.
- Maintenance cost: Low code maintenance, but the scheduler must adapt CommonJS library behavior and expose metadata/reporting around a third-party API.
- Dependency risk: Moderate. As of this decision, npm reports `proper-lockfile@4.1.2`, MIT, last modified 2022-06-24, with runtime dependencies on `graceful-fs`, `retry`, and `signal-exit`. This repository currently has no runtime dependencies, so adopting it expands supply-chain and packaging surface for a narrow primitive.

### Add `lockfile`

- Correctness: Reject. It uses lock files rather than the directory-lock strategy and documents fewer protections around compromised locks and long-running stale checks.
- Portability: Weaker fit for network filesystems because file creation with exclusive flags is a known poor locking primitive on NFS-like systems.
- Failure modes: Stale locks are easier to leave behind or misclassify for long-running workers.
- Maintenance cost: Low.
- Dependency risk: Low to moderate, but not justified given weaker semantics.

### Add native `flock` through `fs-ext`

- Correctness: Strong on many local Unix filesystems for cooperative local processes.
- Portability: Reject for this project. It adds native bindings, platform build concerns, and different semantics on network filesystems.
- Failure modes: Locks can be advisory only, and behavior varies by filesystem and mount options.
- Maintenance cost: Higher because install/build failures become scheduler failures.
- Dependency risk: Highest of the options considered.

### Implement a stricter in-repo directory lock

- Correctness: Accept. Keep atomic `mkdir`, but harden stale cleanup and release with per-owner tokens, metadata validation, heartbeat `mtime` refresh, and atomic stale quarantine by `rename` before removal.
- Portability: Works on local macOS and Linux filesystems that support atomic `mkdir`, same-directory `rename`, directory `mtime`, and normal `rm`.
- Failure modes: Explicit and testable in this repository. Unsupported filesystems fail by timeout or may be documented as unsafe rather than hidden behind a dependency.
- Maintenance cost: Moderate, but the required algorithm is small and directly tied to scheduler diagnostics.
- Dependency risk: None.

## Decision

Use a stricter in-repo directory lock. Do not add a runtime lock dependency for this repository at this stage.

The lock path remains `<graphPath>.lock`. The lock acquisition primitive remains `mkdir(lockPath)`, because it is atomic on supported local macOS and Linux filesystems and avoids the `O_EXCL` file-lock weakness on NFS-like filesystems.

The implementation should adopt these semantics:

- Each acquired lock writes `metadata.json` with `lockVersion`, `ownerId`, `pid`, `host`, `createdAt`, `updatedAt`, and `graphPath`.
- `ownerId` is a random per-acquisition token. A process only releases a lock when the current metadata at `lockPath` still has its `ownerId`.
- While the lock is held, the owner periodically refreshes the lock directory `mtime` and metadata `updatedAt` at an interval below the stale threshold.
- A lock is stale only when the lock directory `mtime` is older than `staleMs`. Default `staleMs` should remain conservative and must be greater than the heartbeat interval.
- Stale cleanup must not run `rm -r lockPath` directly. It must first atomically move the stale lock directory to a unique same-directory quarantine path, such as `<graph>.lock.reap.<pid>.<token>`, and remove that quarantine path. If the rename fails because another process won the race, retry acquisition.
- Releasing a lock must be best-effort and ownership-checked. If ownership no longer matches, report or ignore according to the caller path, but never remove another owner's lock.
- Timeout errors must include available owner metadata and the timeout/stale thresholds.

## Race Conditions To Mitigate

The chosen algorithm specifically mitigates these races:

- Double stale reaper race: two contenders both observe the old lock as stale; contender A removes it and acquires a new lock, then contender B removes `lockPath` after A's acquisition. Quarantine-by-rename prevents B from deleting A's new lock.
- Stale owner release race: owner A pauses longer than `staleMs`; owner B quarantines A's stale lock and acquires a new lock; A resumes and runs `finally`. Owner-token validation prevents A from deleting B's lock.
- Metadata write failure race: a process creates the lock directory but fails to write metadata. Acquisition must remove only its own newly-created directory before exposing success, or fail before entering the critical section.
- Timeout diagnostic race: a waiter reads metadata while the owner is updating or another process is reaping. Metadata reads must be best-effort; failed or partial reads should not crash acquisition unless the lock operation itself fails.
- Mixed stale settings race: different callers using incompatible stale/heartbeat settings can incorrectly reap live locks. The scheduler should centralize defaults and avoid per-call stale settings outside tests.

## Network Filesystems

Supported operation is local filesystem operation on macOS and Linux. Network filesystems are not a supported correctness boundary for this scheduler unless they provide all of these semantics coherently across clients: atomic `mkdir`, atomic same-directory `rename`, visible directory `mtime` updates, and timely metadata visibility.

On NFS, SMB, synced folders, or cloud-mounted paths, the scheduler should be documented as unsupported for concurrent workers. It may still work on some mounts, but correctness is not guaranteed. Operators who need concurrent workers should keep the graph on a local disk or run all mutations through one host-local scheduler process. If a network filesystem causes stale misclassification or metadata visibility lag, the expected behavior is bounded waiting followed by a lock timeout with owner metadata when available, not a guarantee of mutual exclusion.

## Migration Notes

Implementation work belongs in `TEN11`:

- Replace direct stale `rm(lockPath)` with same-directory quarantine `rename` followed by removal of the quarantine path.
- Add random `ownerId` and `lockVersion` to metadata.
- Add ownership-checked release so `finally` cannot remove another process's lock.
- Add heartbeat refresh while the critical section is running, and clear it before release.
- Keep timeout, retry, and stale thresholds configurable for tests, but centralize production defaults.
- Extend tests to cover concurrent stale reapers, stale owner release after another owner acquires, metadata write failure cleanup, and bounded timeout diagnostics.
- Update operator documentation after implementation to state local filesystem support and network filesystem limitations.
