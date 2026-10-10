# Tiny three-object mutable dispatch

[PR #68](https://github.com/zkochan/bit/pull/68) found three-object frames in concurrent imports, while sequential imports still submitted singletons. The helper now extends the existing direct path from tiny pairs to **two or three objects totaling at most 4,096 serialized bytes, including headers**. Singletons remain direct at every accepted size. Larger pairs/triples and four-to-sixteen-object frames retain parallel compression/persistence.

This is a bounded CPU/latency tradeoff. Canonical Node parsing, merge policy, serialization and round-trip validation still precede the native write. Complete request validation, ordered results/acknowledgements, per-object rejection, atomic replacement, ownership/permissions and helper-exit-before-retry remain applicable. There is no protocol, coordinator, queue order, dependency, eligibility limit or default-enable change; tar stays opt-in.

## Kernel comparison

The kernel driver adds three-object synthetic cases, optional named-case selection, and optional canonical payloads from the genuine compiled CLI. `3xreal-version` clones a real Version and changes its log message before recalculating its identity and serializing it. `3xreal-history` combines two such Versions with a canonical eight-entry VersionHistory carrying a distinct name. These are persistence inputs, not a merge benchmark; the kernel does not traverse their references. Fixture construction, parsing, serialization and validation happen outside timing.

Every run uses a fresh store, excludes eight warm frames, verifies all persisted inflated bytes after timing, and reaps the helper. Five retained alternating rounds follow one excluded round, Linux x64, Node 24.21.0. The same production coordinator talks to both release helpers. CPU sums Node resource usage and helper Linux `/proc` ticks during acknowledged frame loops; helper ticks have 10 ms resolution. Startup, canonical policy and readback are excluded. Helpers and compiled modules are hash-guarded before/after; reports bind harness, coordinator and candidate store sources.

Median elapsed milliseconds / CPU seconds:

| Filesystem | Payload / frame       | Merged helper | Candidate helper |
| ---------- | --------------------- | ------------: | ---------------: |
| tmpfs      | 1 × synthetic 1 KiB   |  92.2 / 0.100 |     87.2 / 0.093 |
| tmpfs      | 2 × synthetic 1 KiB   | 142.6 / 0.150 |    140.8 / 0.143 |
| tmpfs      | 3 × synthetic 1 KiB   | 144.1 / 0.396 |    197.1 / 0.200 |
| tmpfs      | 4 × synthetic 1 KiB   | 140.5 / 0.430 |    147.5 / 0.451 |
| tmpfs      | 3 × synthetic 8 KiB   | 115.4 / 0.297 |    115.3 / 0.312 |
| tmpfs      | 3 × real Version      | 153.0 / 0.429 |    228.3 / 0.242 |
| tmpfs      | 2 × Version + history | 158.3 / 0.445 |    246.7 / 0.251 |
| Btrfs      | 1 × synthetic 1 KiB   | 173.5 / 0.174 |    171.4 / 0.175 |
| Btrfs      | 2 × synthetic 1 KiB   | 323.2 / 0.315 |    319.3 / 0.316 |
| Btrfs      | 3 × synthetic 1 KiB   | 295.8 / 0.760 |    453.2 / 0.435 |
| Btrfs      | 4 × synthetic 1 KiB   | 349.0 / 1.020 |    348.6 / 1.011 |
| Btrfs      | 3 × synthetic 8 KiB   | 215.1 / 0.531 |    217.4 / 0.538 |
| Btrfs      | 3 × real Version      | 310.6 / 0.807 |    495.8 / 0.489 |
| Btrfs      | 2 × Version + history | 305.1 / 0.788 |    516.7 / 0.504 |

Each row contains 4,096 frames except the synthetic 8 KiB triple, capped at 2,688 by the 64 MiB input budget. Actual serialized frame sizes are 3,267 bytes for synthetic 1 KiB triples, 1,686–1,695 for real Versions, 2,434–2,443 for the mixed history case, and 24,771 for the larger triple. Only the three small triple rows change dispatch. Their CPU falls 44–49% on tmpfs and 36–43% on Btrfs, while elapsed time rises 37–56% and 53–69% respectively. Other rows are unchanged-path controls showing normal variation. These results do not support a frame-latency speedup or a larger cutoff.

## Complete import comparison

The unchanged genuine compiled production CLI runs with the merged and candidate helpers through actual progressive HTTP imports. Nine retained alternating fresh-process rounds follow excluded warm-up for `concurrent-mutable` on each filesystem. This fixture has four remotes, one hundred components per remote, eight Versions and one 1 KiB Source per component. Separate instrumented cold/warm diagnostics verify native coverage and frame accounting; timing excludes diagnostic wrappers. Both helper and compiled-module snapshots are checked before/after.

Cold command medians:

| Filesystem | Merged wall ms | Candidate wall ms | Merged CPU s | Candidate CPU s | Merged RSS MiB | Candidate RSS MiB |
| ---------- | -------------: | ----------------: | -----------: | --------------: | -------------: | ----------------: |
| tmpfs      |          583.6 |             588.2 |         0.96 |            0.95 |          231.3 |             225.8 |
| Btrfs      |          643.7 |             646.8 |         1.11 |            1.06 |          224.8 |             223.7 |

Tmpfs CPU medians fall 1.0%, with overlapping interquartile ranges of 0.95–0.97 versus 0.94–0.95 seconds. Btrfs falls 4.5%, with 1.10–1.14 versus 1.05–1.10 seconds. Wall medians rise 0.8% and 0.5%; interquartile ranges overlap: 582.5–601.7 versus 584.8–595.5 ms on tmpfs, and 637.9–660.9 versus 640.9–653.3 ms on Btrfs. This supports a modest CPU reduction on the Btrfs workload; tmpfs evidence is weaker. It establishes neither a broad speedup nor a reliable memory saving.

Both helpers persist the same 3,600 mutable objects with zero fallback. Diagnostic one-/two-/three-object histograms are 943/1,051/185 versus 893/1,205/99 on tmpfs and 856/985/258 versus 985/889/279 on Btrfs. Histogram totals equal native submission/batch counts. These are separate diagnostic commands, not timed-round distributions, and count all triples rather than only triples below the cutoff. Scheduling affects frame density even with the identical coordinator, so complete-command results include that effect. Warm commands submit no mutable writes and cannot establish a dispatch benefit.

Every cold/warm command verifies all Source bytes, canonical models/Versions/tags/heads and indexes. Diagnostics retain native Source coverage, zero Source hydration/fallback and zero incoming metadata inflation; Version parsing/serialization/round-trip validation remain active. Eight additional workloads pass on both filesystems with three retained alternating rounds per helper after excluded warm-up: many-small, large-compressible, large-binary, mutable-heavy, multi-remote, seeded local overlap, and histories retaining 32 or 512 local plus incoming Versions. Separate diagnostics pass the same native coverage/validation/readback gates. Large retained histories still exceed the existing 16 KiB native eligibility limit and use canonical persistence.

Additional regression cold wall medians in milliseconds:

| Filesystem | Workload            | Merged helper | Candidate helper |
| ---------- | ------------------- | ------------: | ---------------: |
| tmpfs      | many-small          |         421.1 |            395.9 |
| tmpfs      | large-compressible  |         334.3 |            334.7 |
| tmpfs      | large-binary        |         344.0 |            348.3 |
| tmpfs      | mutable-heavy       |         747.1 |            723.3 |
| tmpfs      | multi-remote        |         325.0 |            312.4 |
| tmpfs      | history-overlap-32  |         297.1 |            305.8 |
| tmpfs      | history-overlap-512 |         522.2 |            502.7 |
| tmpfs      | overlap-local       |         450.0 |            464.6 |
| btrfs      | many-small          |         459.7 |            421.8 |
| btrfs      | large-compressible  |         334.2 |            338.1 |
| btrfs      | large-binary        |         367.1 |            342.1 |
| btrfs      | mutable-heavy       |         808.8 |            839.6 |
| btrfs      | multi-remote        |         311.4 |            308.9 |
| btrfs      | history-overlap-32  |         306.1 |            303.2 |
| btrfs      | history-overlap-512 |         653.9 |            673.8 |
| btrfs      | overlap-local       |         550.1 |            560.3 |

These short regression runs show mixed changes, including increases on unchanged single-remote singleton paths. They do not establish speedups or regressions attributable to triple dispatch. Sequential mutable-heavy still sends 3,600 singleton frames, whose direct path is unchanged. All rounds are retained.

## Validation and reproduction

The real-helper regression compares exact compressed bytes and returned lengths with singleton writes at total serialized sizes 4,096 and 4,099 bytes. A valid Version, invalid Source and valid VersionHistory preserve ordered successful/null results and exact readback. The existing native platform matrix already runs this test file. All 219 applicable Node tests pass with one platform-specific skip, including shared origin/cache interrupted-prefix and large retained-history loss regressions, using the candidate release helper and source-bound packaged artifact. All 60 Rust workspace tests, inherited pinned formatting, warning-denied Clippy, perfectionist Dylint and rustdoc pass without new exceptions. Prettier, syntax, diff and Oxlint checks pass.

Canonical `npm run lint` passes in the existing isolated compiled CLI, whose production source graph is unchanged by this chunk. Running it directly in the worktree fails because shared `node_modules` source links resolve to the user's main checkout and mix incompatible class declarations. An external all-local TypeScript path experiment also fails on unrelated existing type errors; neither changes source or dependencies. The original `rust` branch and user lockfile remain untouched.

Evidence, logs and the source-digest-bound package remain outside Git in `$HOME/bit-three-object-evidence-2026-10-10`. Merged helper SHA-256: `78d9fc435139d0c740d24ca72e43a936dca9161a5241d1773b215336aeb0df5b`; candidate: `a80ddacc6dcb1a1592736871b2d13bdb71b38236d3aa55c680647ef86b4acdeb`. The package records base revision `97116b7ff16d68eda0e5fdec88372567d4ac5c32` and candidate native source digest `827b36266c65ac083602118d17edd6510170c9ccf069b2c796ed80c0daad464c`. An earlier one-round, 512-frame exploratory run is excluded from these results.

```sh
TMPDIR=/tmp BIT_LEGACY_ROOT=/absolute/compiled-cli \
BIT_MUTABLE_CROSSOVER_REAL_CLI=/absolute/compiled-cli \
BIT_MUTABLE_CROSSOVER_CASES=1x1024,2x1024,3x1024,4x1024,3x8192,3xreal-version,3xreal-history \
BIT_MUTABLE_CROSSOVER_ROUNDS=5 BIT_MUTABLE_CROSSOVER_FRAMES=4096 \
BIT_MUTABLE_CROSSOVER_TMPDIR=/dev/shm \
node --expose-gc scripts/rust-object-import/mutable-crossover.cjs \
  /absolute/merged-helper /absolute/candidate-helper /absolute/evidence/kernel.json

TMPDIR=/tmp BIT_IMPORT_QUALIFICATION_TRANSPORT=http \
BIT_IMPORT_QUALIFICATION_BASELINE_CLI=/absolute/compiled-cli \
BIT_IMPORT_QUALIFICATION_BASELINE_HELPER=/absolute/merged-helper \
BIT_IMPORT_QUALIFICATION_MODES=tar-baseline,tar \
BIT_IMPORT_QUALIFICATION_CASES=concurrent-mutable \
BIT_IMPORT_QUALIFICATION_ROUNDS=9 \
BIT_IMPORT_QUALIFICATION_TMPDIR=/dev/shm \
BIT_IMPORT_QUALIFICATION_REPORT=/absolute/evidence/commands.json \
node --expose-gc scripts/rust-object-import/import-qualification.cjs \
  /absolute/compiled-cli /absolute/candidate-helper
```

Use an external Btrfs directory instead of `/dev/shm` for disk qualification. GNU time includes waited helper CPU; 10 ms sampled simultaneous process-tree RSS excludes the fixture server, filesystem cache and staged bytes. This is Linux local objects-only HTTP qualification, excluding WAN, checkout/install and other platform performance. Payload entropy, ACLs, storage contention and worker counts can shift the tradeoff.

Next, qualify realistic Version dependency/extension/schema construction and error parity before changing projection or parsing. Larger direct-frame thresholds remain unsupported by these measurements. Sequential batching, write-invalidated missing-lookup reuse, external cancellation, arbitrary cross-remote interleaving, LaneHistory, trusted provisioning and broader platform qualification remain open.
