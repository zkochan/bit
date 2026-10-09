# Singleton mutable writes

After [PR #60](https://github.com/zkochan/bit/pull/60), a mutable-heavy progressive HTTP diagnostic still made 3,600 single-object `BMP1` requests. Native compression/persistence requests collectively took about 206 ms in that diagnostic. JavaScript intentionally awaits each acknowledgement before proceeding with canonical merge/write policy.

Rust previously installed every mutable request in its Rayon worker pool, including requests containing just one object. Singleton requests now compress and atomically persist on the serving thread. Requests containing two to sixteen objects retain parallel processing. Every request is fully decoded and validated before persistence; per-object failure still returns `null`, write state clears before the response, and subsequent replacements retain atomic write/ownership/permission behavior. There is no protocol, merge/index, queue-ordering or default-enable change.

A real-helper differential test compares exact compressed bytes and lengths for all three mutable types in singleton and parallel batches, then rejects an unsupported singleton and replaces an earlier identity through the same session. Existing bounds, partial failures, ownership, cancellation, timeout/reap-before-retry and packaged lifecycle tests remain applicable. The portable platform matrix already runs this test file.

Local validation passes 201 Node tests with one platform-specific skip, 60 Rust workspace tests, the exact inherited pinned formatter, warning-denied Clippy and perfectionist Dylint, and warning-denied rustdoc. No native dependencies, lint rules or exceptions change.

## Command qualification

`BIT_IMPORT_QUALIFICATION_BASELINE_HELPER` optionally supplies a distinct helper for `tar-baseline`; otherwise that mode uses the candidate helper as before. The report retains both helper hashes and verifies neither changed during the run. Comparing the same genuine compiled PR #60 CLI with the previous and candidate helpers isolates this Rust change. Shared fixtures/server/initialization/readback remain identical; timing runs exclude instrumentation, and separate diagnostics verify native coverage and canonical results.

Nine retained alternating fresh-process rounds per helper after warm-up, Linux x64, Node 24.21.0. Cold median milliseconds:

| Filesystem | Workload           | Previous helper | Singleton helper |
| ---------- | ------------------ | --------------: | ---------------: |
| tmpfs      | many-small         |           389.9 |            391.3 |
| tmpfs      | large-compressible |           332.9 |            332.1 |
| tmpfs      | large-binary       |           335.0 |            330.7 |
| tmpfs      | mutable-heavy      |           723.8 |            708.1 |
| tmpfs      | multi-remote       |           299.2 |            302.9 |
| btrfs      | many-small         |           416.3 |            413.8 |
| btrfs      | large-compressible |           338.0 |            337.8 |
| btrfs      | large-binary       |           333.7 |            338.0 |
| btrfs      | mutable-heavy      |           803.9 |            800.9 |
| btrfs      | multi-remote       |           307.6 |            303.8 |

Mutable-heavy median total client/helper CPU seconds fall from 1.09 to 1.03 on tmpfs (5.5%) and 1.21 to 1.15 on Btrfs (5.0%). The separate diagnostic measures the same 3,600 successful native mutable requests with no fallback: summed request time falls from 211.3 to 173.7 ms on tmpfs (18%) and 260.1 to 232.2 ms on Btrfs (11%). Diagnostic request times include IPC, compression and filesystem work; they are not isolated worker-dispatch timings.

Mutable-heavy cold wall time improves 2.2% on tmpfs and 0.4% on Btrfs, with overlapping interquartile ranges: 719–732 versus 701–727 ms on tmpfs, and 794–820 versus 783–827 ms on Btrfs. Other workloads remain effectively flat, including small increases in some medians. Repeated commands show no consistent benefit. This supports a modest mutable-heavy CPU reduction, not a broad wall-time speedup.

There is no demonstrated memory saving. Mutable-heavy median sampled simultaneous RSS is 246.5 versus 247.7 MiB on tmpfs and 229.8 versus 246.1 MiB on Btrfs; the latter is higher with the candidate. All five workloads on both filesystems pass complete cold/warm Source/model/version/tag/head/index readback, full native Source coverage, zero Source hydration/fallback and zero incoming metadata inflation. Both modes also persist the same counts of mutable objects with zero mutable fallback.

Raw reports, provenance, test/lint logs and the source-digest-bound packaged candidate remain outside Git in `$HOME/bit-singleton-evidence-2026-10-09`. Previous helper SHA-256: `71cede471917682eb3597fcd3bd0ba3bcc89e3f4f5e7cdabd944feb41423a07b`; candidate: `cee893c96e20c35c82c2e80e362c08793d215fdce02a6411eeb6f383b7d798e3`. The candidate package records the base revision and exact modified native source digest. No generated evidence is committed.

Next, investigate ordered mutable request batching or operation-level coordination only with canonical visibility, acknowledged-prefix error and cross-remote ordering qualification. Native merge/index kernels, trusted automatic provisioning and broader platform/ACL/WAN/checkout/install qualification remain open.

Reproduce with the separately compiled PR #60 CLI and old/new release helpers:

```sh
TMPDIR=/tmp \
BIT_IMPORT_QUALIFICATION_TRANSPORT=http \
BIT_IMPORT_QUALIFICATION_BASELINE_CLI=/absolute/compiled-pr60 \
BIT_IMPORT_QUALIFICATION_BASELINE_HELPER=/absolute/pr60-helper \
BIT_IMPORT_QUALIFICATION_MODES=tar-baseline,tar \
BIT_IMPORT_QUALIFICATION_ROUNDS=9 \
BIT_IMPORT_QUALIFICATION_TMPDIR=/dev/shm \
BIT_IMPORT_QUALIFICATION_REPORT=/absolute/evidence/results.json \
node --expose-gc scripts/rust-object-import/import-qualification.cjs \
  /absolute/compiled-pr60 /absolute/candidate-helper
```

Use a disk directory outside Git for Btrfs. These are actual local production HTTP objects-only imports, excluding checkout/install and WAN qualification. GNU time includes waited helper CPU; 10 ms simultaneous process-tree RSS excludes server memory, filesystem cache and staged bytes. Diagnostic inclusive stage times are not additive. Tar remains opt-in.
