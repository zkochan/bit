# Version validation and mutable dispatch attribution

[History scaling](./history-scaling.md) pointed toward Version processing rather than model/history merge policy. Diagnostics now separate Version parsing inside persistence validation from other parsing, and record actual mutable protocol frame sizes. A new `tar-node-mutable` qualification mode retains native progressive HTTP intake, metadata inflation and Source writes, but uses the existing Node mutable writer through `BIT_RUST_OBJECT_IMPORT_MUTABLE=off`. Runtime and Rust code are unchanged; tar remains opt-in.

## What the diagnostics measure

`Version.toBuffer()` projects the model to an object, stringifies it, reparses the serialized string through `Version.parse()` and performs full Version validation before returning its Buffer. The persistence parse therefore includes another canonical Version construction. Removing it would change validation behavior, rather than merely remove redundant compression.

The preload records `versionSerialization`, `versionObjectProjection`, `versionPersistValidation`, `versionParseForPersistence`, `versionParseOther`, `versionConstructorChecks` and `versionFullValidation`. An async-local context identifies persistence-validation parsing and restores context after errors. `Other` includes incoming hydration and later repository/command reads; it must not be treated as an incoming-only counter. Serialized Version counts and body bytes are recorded separately from protocol frame bytes, which include headers and other mutable types.

The wrapper preserves synchronous results, Buffer contents, original errors and repeated-load behavior. It leaves `serialize` and `compressWithSize` method identities intact because native eligibility compares them with BitObject's methods. Tests explicitly verify those identities and context restoration after a failed validation. Separate profiles use the existing inspector preload without these diagnostic wrappers.

`mutableFrames.counts` records the actual object count when a queued frame executes, rather than the size of individual caller requests. Successful diagnostics require histogram totals to equal native batch/submission counters. Frame durations include helper/IO waits and are not CPU time. All stage durations are inclusive, can nest or overlap, include instrumentation overhead and must not be added together.

## Production command comparison

Four genuine production objects-only HTTP workloads run in canonical (`legacy`), native mutable (`tar`) and Node mutable control (`tar-node-mutable`) modes. Three retained alternating fresh-process rounds per mode follow excluded warm-up on each filesystem. Separate cold/warm diagnostic and profile pairs are verified independently and excluded from retained timings. Every command passes full Source/model/Version/history/index readback and identical persisted-object digests across modes.

Native and control modes both require full native Source coverage, zero Source hydration/fallback, zero incoming metadata inflation and actual canonical hydration of native metadata. The control must submit zero native mutable writes. Every cold command must trace Version parsing, serialization and serialized validation. The scaled history retains exact local state, tags, parents, complete markers and remote-main refs, including canonical persistence for the history above 16 KiB. Warm commands do not exercise mutable dispatch.

Cold wall / total CPU medians for native mutable writes versus the Node mutable control:

| Filesystem | Workload            | Native wall ms | Node mutable wall ms | Native CPU s | Node mutable CPU s |
| ---------- | ------------------- | -------------: | -------------------: | -----------: | -----------------: |
| tmpfs      | many-small          |          389.0 |                412.2 |         0.56 |               0.57 |
| tmpfs      | mutable-heavy       |          703.7 |                949.5 |         1.01 |               1.32 |
| tmpfs      | concurrent-mutable  |          582.9 |                698.2 |         0.93 |               1.15 |
| tmpfs      | history-overlap-512 |          489.8 |                628.0 |         0.68 |               0.84 |
| btrfs      | many-small          |          433.0 |                446.7 |         0.67 |               0.66 |
| btrfs      | mutable-heavy       |          793.0 |              1,057.5 |         1.12 |               1.47 |
| btrfs      | concurrent-mutable  |          627.2 |                708.4 |         1.06 |               1.25 |
| btrfs      | history-overlap-512 |          531.2 |                639.9 |         0.73 |               0.86 |

This is a control comparison of existing paths, not a new optimization speedup. Three rounds and one profile/diagnostic pair per case/mode/filesystem support candidate selection rather than precise performance estimates. Switching the mutable writer affects compression, persistence, ownership lookups and GC/cache lifetimes; the difference is not isolated RPC cost. Linux x64, Node 24.21.0. GNU time includes waited helper CPU; profiles cover only the owning CLI main thread. The loopback server is outside those measurements.

## Parsing and frame findings

The tmpfs native mutable-heavy diagnostic records 3,200 ordinary Version parses, 3,200 persistence-validation parses and 3,200 serialized Versions. Serialization sums to 55.76 ms inclusively, including 34.64 ms of persistence validation; persistence parsing sums to 11.54 ms. These nested diagnostic sums include wrapper overhead and cannot be added to estimate CPU savings. The separate cold main-thread profile attributes approximately 23.07 ms of self samples to the Version module, including parsing, construction, projection, serialization and validation; descendant work is outside module self samples. One millisecond sampling can miss short functions.

The same control also serializes and persistence-validates 3,200 Versions. It records 3,600 other parses versus 3,200 in native mode. The preload counts whole commands, and weak cache lifetimes and later repository reads can vary with timing/GC; this observation does not authorize stronger caching or skipping validation.

Native tmpfs frame histograms:

| Workload            | One object | Two objects | Three objects | Submitted objects |
| ------------------- | ---------: | ----------: | ------------: | ----------------: |
| many-small          |        300 |           0 |             0 |               300 |
| mutable-heavy       |      3,600 |           0 |             0 |             3,600 |
| concurrent-mutable  |        715 |       1,255 |           125 |             3,600 |
| history-overlap-512 |      2,048 |           0 |             0 |             2,048 |

Single-remote command ordering prevents coalescing sequential mutable requests; existing coalescing groups requests that are already queued from concurrent remotes. Histogram distributions depend on scheduling and need not match between runs/filesystems. They are diagnostic examples, not retained timing distributions. The control comparison supports retaining Rust writes despite singleton frames. The existing helper directly processes singletons and tiny two-object frames, while three-object frames use its parallel path.

Btrfs concurrent-mutable records 851 singleton, 998 two-object and 251 three-object frames, again covering all 3,600 submissions. The other Btrfs histograms match their tmpfs counterparts. Native mutable-heavy Version serialization/persistence-validation diagnostic sums are 57.94/35.81 ms on Btrfs, with 31.57 ms of Version module self samples in its separate cold profile. The many-small CPU difference is small and changes direction between filesystems; these results establish no uniform CPU or memory saving.

Next: measure the three-object dispatch crossover on real serialized payloads before extending the tiny-frame direct path. Keep canonical parsing, round-trip validation and acknowledgements intact. Reducing Version construction/projection overhead remains a separate candidate requiring realistic dependency/extension/schema and error-parity coverage; these fixtures do not justify removing validation or adding a cache.

## Validation and reproduction

All 218 applicable Node tests pass, with one platform-specific skip. Two new portable regressions cover Version diagnostics/eligibility/error preservation and actual frame-size accounting; the existing native platform matrix runs the modified trace test file. Full private compiled-CLI regressions, including shared origin/cache interruption and large retained-history loss detection, pass locally. Prettier, Node syntax and diff checks pass. PR #67 merged with all seventeen runnable checks passing. Production/Rust sources, protocols, dependencies, lint rules, user rust branch and lockfile are unchanged.

Reports, separate profiles, excluded exploratory reports and logs remain outside Git in `$HOME/bit-version-attribution-evidence-2026-10-10`. Compiled module and helper before/after guards pass, and retained harness provenance matches the source. The unchanged helper SHA-256 is `78d9fc435139d0c740d24ca72e43a936dca9161a5241d1773b215336aeb0df5b`.

```sh
TMPDIR=/tmp \
BIT_IMPORT_QUALIFICATION_TRANSPORT=http \
BIT_IMPORT_QUALIFICATION_MODES=legacy,tar,tar-node-mutable \
BIT_IMPORT_QUALIFICATION_CASES=many-small,mutable-heavy,concurrent-mutable,history-overlap-512 \
BIT_IMPORT_QUALIFICATION_ROUNDS=3 \
BIT_IMPORT_QUALIFICATION_TMPDIR=/dev/shm \
BIT_IMPORT_QUALIFICATION_CPU_PROFILE_DIR=/absolute/evidence/profiles \
BIT_IMPORT_QUALIFICATION_REPORT=/absolute/evidence/results.json \
node --expose-gc scripts/rust-object-import/import-qualification.cjs \
  /absolute/compiled-cli /absolute/merged-release-helper
```

Use an external Btrfs scratch directory for disk variation. Broader platform/ACL/WAN/checkout/install qualification, trusted provisioning, external cancellation, arbitrary cross-remote interleaving, sequential batching, LaneHistory and write-invalidated missing-lookup reuse remain open under #33.
