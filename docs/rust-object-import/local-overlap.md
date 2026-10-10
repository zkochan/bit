# Seeded local-overlap qualification

[PR #64](https://github.com/zkochan/bit/pull/64) showed that fresh destinations never exercised model/history merge policy. Two explicitly selected HTTP workloads now seed existing models, Versions and VersionHistories before importing. Seeding runs outside command timing through canonical repository writes and never writes to a shared scope. The six default fresh workloads remain unchanged.

Both workloads have two remotes with sixty-four components each, eight incoming versions and one 1 KiB Source per component. Each local seed contains three additional Versions and a history containing those Versions plus an overlapping incoming Version. Seeds contain no Sources, so incoming Source coverage remains measurable. Canonical compressed seed buffers are stored in the external fixture manifest and decoded through the canonical parser when preparing each destination.

- `overlap-origin` replaces an existing `1.0.0` tag, adds incoming tags, moves an origin-absent non-local tag to orphaned versions, retains an existing orphaned version and local history entries, and advances the model head to the incoming origin head.
- `overlap-local` retains a locally marked tag, its state and the local head while adding incoming tags. The persisted remote-main ref records the incoming origin head independently of the retained local head.

Readback verifies all 1,792 expected objects, full Source bytes, model tags/heads/state/orphaned versions, exact history hashes/parents, retained graph-complete markers, component indexes and persisted remote-main refs. Seed-only Versions are included in readback without being mistaken for incoming protocol objects. Cold diagnostics explicitly require model and VersionHistory merge policy coverage; each successful workload executes 128 calls to each policy in both canonical and native modes.

## Canonical/native command comparison

Genuine production `bit import --objects --all-history` HTTP commands use one unchanged compiled JavaScript graph and the merged PR #63 helper. PR #64 only changed qualification scripts, so both match the merged production implementation. Nine retained alternating fresh-process rounds per mode follow excluded warm-up on tmpfs and Btrfs. Every cold/warm command passes canonical readback and identical whole-model digests across modes. Native diagnostics verify full Source coverage, zero Source hydration/fallback, zero incoming metadata inflation, 1,152 successful native mutable writes with zero fallback, and zero warm mutable submissions.

Cold medians for the existing canonical (`legacy`) and native (`tar`) paths:

| Filesystem | Workload       | Canonical wall ms | Native wall ms | Canonical CPU s | Native CPU s |
| ---------- | -------------- | ----------------: | -------------: | --------------: | -----------: |
| tmpfs      | overlap-origin |             529.7 |          443.0 |            0.81 |         0.64 |
| tmpfs      | overlap-local  |             525.6 |          453.1 |            0.79 |         0.65 |
| btrfs      | overlap-origin |             533.8 |          461.0 |            0.85 |         0.68 |
| btrfs      | overlap-local  |             522.5 |          463.4 |            0.80 |         0.70 |

These are context for existing paths on the new fixtures; this chunk changes no production importer or Rust kernel. Linux x64, Node 24.21.0. GNU time includes waited helper CPU, while the separate inspector profile covers only the owning CLI main thread. Timed rounds exclude diagnostics and profiling. Compiled module snapshots and the helper pass before/after hash guards; harness provenance matches the retained sources.

Separate native cold diagnostics report summed inclusive model-policy milliseconds of 70.35 / 90.41 on tmpfs and 81.65 / 123.21 on Btrfs for origin / local respectively. VersionHistory policy sums are 1.26 / 1.27 and 1.31 / 1.29 ms. Asynchronous model calls overlap and include awaited work, so these sums are not CPU time and cannot be added to other stages.

Separate cold native main-thread profiles attribute approximately 0 / 0 ms of self samples to the model-merger module on tmpfs and 0 / 0.9 ms on Btrfs. Version-history module self samples are approximately 2.1 / 3.2 and 1.1 / 2.1 ms; those include history code beyond `merge`. A zero self sample does not prove zero CPU: short functions can fall between 1 ms samples and descendant work is excluded. One profile/diagnostic pair per mode/workload/filesystem supports attribution, not a precise kernel cost or proof that a native merge would help.

## Conflict and acknowledged objects

`overlap-failure.cjs` creates two seeded components whose origin tag conflicts with an explicitly local tag. It runs genuine canonical and native HTTP CLI commands against fresh destinations and requires a nonzero conflict result identifying `1.0.0`. Both paths execute model policy and merge two existing histories before the model merge fails.

Complete post-failure readback verifies the old model tags, local state/head, indexes and absence of a newly committed remote-main ref. All incoming Sources/Versions and merged histories remain readable, including retained local history. Native diagnostics verify two native Sources and ten acknowledged mutable writes with zero fallback; the final whole-model digest matches canonical failure behavior. This passes on tmpfs and Btrfs with helper and compiled module hash guards and an isolated globals directory. The loopback server startup and command execution are bounded, and the server and temporary stores are removed after the check.

This qualifies a model conflict after incoming object acknowledgements. Transport interruption, cancellation and duplicate identities arriving concurrently from different remote streams remain separate qualification work.

## Repository regressions and limits

Three full compiled-repository regressions independently apply canonical merge policy to the seeded fixtures, verify all retained state, and deliberately remove a local history entry to ensure readback rejects data loss. The cached-remote regression uses `MultipleComponentMerger` with an incoming component under a non-origin remote key: incoming tags become orphaned versions while existing tags, state and local head remain, and no authoritative remote head is written. This is repository-level cached-policy coverage. The two HTTP workloads use disjoint identities across their remotes; shared-identity cached/origin HTTP ordering is still open. LaneHistory objects are not included.

All 214 applicable Node tests pass with one platform-specific skip. The three new fixture regressions require the full private compiled CLI graph, as do the existing repository qualification suites; they were run locally. The lightweight native platform matrix retains its existing tests. Prettier, Node syntax and diff checks pass. Rust sources, dependencies and lint rules are unchanged; inherited PR #64 CI passed all seventeen runnable checks. A many-small canonical/native command regression also passes through the unchanged fresh-fixture path.

Raw reports, separate CPU profiles, conflict checks, provenance and logs remain outside Git in `$HOME/bit-local-overlap-evidence-2026-10-10`. Exploratory checks are excluded from the final tables. The unchanged helper SHA-256 is `78d9fc435139d0c740d24ca72e43a936dca9161a5241d1773b215336aeb0df5b`. Tar remains opt-in.

## Reproduction and next chunk

```sh
TMPDIR=/tmp \
BIT_IMPORT_QUALIFICATION_TRANSPORT=http \
BIT_IMPORT_QUALIFICATION_MODES=legacy,tar \
BIT_IMPORT_QUALIFICATION_CASES=overlap-origin,overlap-local \
BIT_IMPORT_QUALIFICATION_ROUNDS=9 \
BIT_IMPORT_QUALIFICATION_TMPDIR=/dev/shm \
BIT_IMPORT_QUALIFICATION_CPU_PROFILE_DIR=/absolute/evidence/profiles \
BIT_IMPORT_QUALIFICATION_REPORT=/absolute/evidence/results.json \
node --expose-gc scripts/rust-object-import/import-qualification.cjs \
  /absolute/compiled-cli /absolute/merged-release-helper

TMPDIR=/tmp BIT_IMPORT_QUALIFICATION_TMPDIR=/dev/shm \
node scripts/rust-object-import/overlap-failure.cjs \
  /absolute/compiled-cli /absolute/merged-release-helper /absolute/evidence/failure.json

TMPDIR=/tmp BIT_LEGACY_ROOT=/absolute/compiled-cli \
node --test scripts/rust-object-import/overlap-fixture.test.cjs
```

Use an external Btrfs scratch directory for disk variation. Next qualify larger overlapping histories and cached/origin shared identities over HTTP, including cancellation and ordered-prefix failures, and profile their scaling before selecting a bounded native kernel. Missing-lookup reuse still requires write invalidation/visibility qualification. Sequential batching, LaneHistory coverage, trusted provisioning and broader platform/ACL/WAN/checkout/install qualification remain open.
