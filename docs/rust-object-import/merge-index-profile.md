# Merge/index attribution and fixture coverage

After [PR #63](https://github.com/zkochan/bit/pull/63), the next proposed work was a bounded native merge/index kernel. The existing `componentMergeAndIndex` stage measures an asynchronous operation that includes canonical component lookup, object compression/persistence, scope indexing and remote-lane updates. Its inclusive elapsed time cannot identify a CPU kernel by itself.

This chunk adds separate stage counters for repository loads/writes, existing component lookups, multiple-component merge, model/history merge policies, scope-index addition/write and remote-lane entries. Successful repository/component lookups count found versus missing results. Stage durations remain summed inclusive elapsed times, include awaited work and overlap; they are never added together or treated as CPU time.

`BIT_IMPORT_QUALIFICATION_CPU_PROFILE_DIR` optionally adds a separate cold/warm command pair for each selected mode and workload. An inspector preload samples the owning CLI main thread at 1 ms and emits Chrome-compatible `.cpuprofile` files on exit. Forked analytics-style children inherit the owner identity and cannot start or overwrite that profile. These commands have no async-hook diagnostic preload and never enter the retained uninstrumented timing rounds. Their full canonical readback is verified, and profile paths plus command results are recorded under `cases.<name>.profiles`. Helper CPU and other Node threads are outside the main-thread profile; idle, garbage collection and startup samples are included and must be interpreted separately.

## Measured scope

One unchanged compiled PR #62 JavaScript graph and the merged PR #63 release helper run genuine production objects-only HTTP imports. PR #63 only changed Rust, so this compiled graph also matches its production JavaScript. All six workloads pass on tmpfs and Btrfs, with three retained fresh-process timing rounds after excluded warm-up, a separate cold/warm CPU-profile pair and a separate cold/warm diagnostic pair per workload. Linux x64, Node 24.21.0. This is an attribution study with one profile/diagnostic pair per workload/filesystem, not a before/after performance comparison.

Every command verifies full Sources and canonical models, versions/tags/heads and indexes. Diagnostics retain full native Source coverage, zero Source hydration/fallback, zero incoming metadata inflation, successful native mutable counts and zero mutable fallback. The unchanged helper and compiled snapshot pass their hash guards; harness hashes are recorded. Generated evidence stays outside Git in `$HOME/bit-merge-index-evidence-2026-10-10`. An earlier exploratory trace without lookup outcome counters is retained separately and excluded from the final tables.

Separate cold diagnostic summed inclusive milliseconds:

| Filesystem | Workload           | Component merge/index | Multiple-component merge | Repository write/index | Index write | Remote-lane entries |
| ---------- | ------------------ | --------------------: | -----------------------: | ---------------------: | ----------: | ------------------: |
| tmpfs      | many-small         |                 26.73 |                     1.47 |                  29.28 |        1.06 |                1.14 |
| tmpfs      | mutable-heavy      |                 46.76 |                     7.54 |                  32.45 |        1.19 |                9.67 |
| tmpfs      | concurrent-mutable |                 58.48 |                     4.11 |                  67.72 |        1.24 |                7.74 |
| btrfs      | many-small         |                 16.70 |                     1.42 |                  18.61 |        1.08 |                1.18 |
| btrfs      | mutable-heavy      |                 46.58 |                     7.87 |                  31.48 |        1.43 |                9.94 |
| btrfs      | concurrent-mutable |                 59.32 |                     8.83 |                  63.17 |        1.30 |                7.98 |

Repository load and component lookup sums can exceed command wall time because calls overlap. Across the whole cold mutable-heavy and concurrent-mutable commands, each diagnostic records 8,000 repository loads: 3,200 found and 4,800 missing. Existing-component lookup records 2,400 calls: 1,200 found and 1,200 missing. Many-small records 1,400 repository loads (800 found / 600 missing) and 600 component lookups (300 found / 300 missing). These counts include post-import queries as well as intake and are not isolated merge-stage counts. They identify missing-object lookup work worth further investigation without establishing that all missing loads are redundant or safely cacheable.

The tmpfs cold main-thread profiles attribute sampled self time to the multiple-component merger module of approximately 0, 1.1 and 0.5 ms for many-small, mutable-heavy and concurrent-mutable. Scope-index module self samples are approximately 1.1, 0 and 0 ms. A zero sample is not proof of zero CPU work: short functions can fall between samples, and descendants are not included in module self time. There are no samples from `model-components-merger`, consistent with the independent policy call counts below. The profiles also show startup/module loading, Version parsing/serialization, repository operations, GC and idle samples; kernel helper CPU is not visible here.

## Qualification gap and next chunk

Every fresh destination uses the absent-component fast path. **None of the twelve cold diagnostics calls `ModelComponentMerger.merge`, `VersionHistory.merge` or `LaneHistory.merge`.** Warm diagnostics submit no mutable writes. These fixtures qualify fresh import/persistence and indexing, but provide no evidence about native replacement-tag, orphaned-version, local-state, conflict or history-merge policy. Lane-history objects are absent entirely. Model/history native kernels cannot be selected or qualified from these results.

The next chunk should add local-overlap fixtures before moving merge policy: seed existing models and histories, then import origin replacements/additions and cached-remote data. Verify retained local state, orphaned versions, tags/heads, history entries and indexes, and explicitly assert that the intended policy branches ran. Include cross-remote repeated identities and an acknowledged-prefix failure/cancellation case before changing operation ordering or batching. Then profile that workload to choose a bounded kernel. Missing-object lookup work is another candidate, but any miss reuse needs write invalidation and cross-remote visibility qualification; this study adds no cache.

Production import policy, Rust sources/protocols, dependencies and default enablement are unchanged. Tar remains opt-in. Trusted provisioning and broader platform/ACL/WAN/checkout/install qualification remain open.

## Validation and reproduction

All 211 applicable Node tests pass with one platform-specific skip. New portable tests verify synchronous index result/error identity, independent model/history policy counters, lookup outcomes and command-only CPU profile ownership with an actual forked child. The existing native platform matrix already runs the modified test file. Prettier, Node syntax and diff checks pass. The inherited Rust implementation is unchanged and PR #63's seventeen merged CI checks pass.

```sh
TMPDIR=/tmp \
BIT_IMPORT_QUALIFICATION_TRANSPORT=http \
BIT_IMPORT_QUALIFICATION_MODES=tar \
BIT_IMPORT_QUALIFICATION_ROUNDS=3 \
BIT_IMPORT_QUALIFICATION_TMPDIR=/dev/shm \
BIT_IMPORT_QUALIFICATION_CPU_PROFILE_DIR=/absolute/evidence/profiles \
BIT_IMPORT_QUALIFICATION_REPORT=/absolute/evidence/results.json \
node --expose-gc scripts/rust-object-import/import-qualification.cjs \
  /absolute/compiled-pr63-cli /absolute/pr63-release-helper
```

Use an external Btrfs scratch directory for disk variation. The profile directory must be outside this Git workspace. Open the `.cpuprofile` artifacts with Chrome DevTools or another V8 profile viewer. Profiling adds overhead, so use `runs` for uninstrumented timings and `profiles` only for attribution. The unchanged helper SHA-256 is `78d9fc435139d0c740d24ca72e43a936dca9161a5241d1773b215336aeb0df5b`.
