# Already queued mutable request batches

[PR #61](https://github.com/zkochan/bit/pull/61) removed worker dispatch for singleton BMP1 requests, but the shared operation-level mutable helper still received one frame per caller. Different remote writers already submit requests concurrently and wait for their own persistence acknowledgement.

The coordinator now coalesces adjacent requests that are already waiting on its serialized tail. It adds no timer or artificial delay and does not defer sequential JavaScript policy decisions to create a batch. Once a group starts, its inputs are sealed. Up to sixteen distinct identities share one existing BMP1 frame; each caller receives its original ordered result slice only after the group acknowledgement. The global sixty-four outstanding object limit still applies, with at most 512 KiB per object and 8 MiB per frame.

A repeated identity closes the current group and starts an ordered replacement group. Validation/select/commit operations also close the group, retaining their position on the same serialized tail. Per-object rejection affects only the corresponding caller's result. Helper/protocol failures return unavailable results after helper exit, preserving reap-before-canonical-retry. Disposal settles accepted queued callers without spawning new work. There is no new protocol, Rust kernel, merge/index policy, ownership rule or default enablement.

Seven new real-helper regressions cover bounded frame counts with exact caller slices, FIFO duplicate replacements, mixed multi-object slices and partial rejection, a real validation/select/commit barrier, sixty-four-object admission, disposal before helper startup, and coalesced timeout exit before fallback. Existing canonical repository, HTTP replay/cancellation and packaged lifecycle tests remain applicable. The portable platform matrix already runs the modified test file.

The genuine isolated candidate compiles and passes canonical npm lint. All 208 applicable Node tests pass with one platform-specific skip; all 60 Rust workspace tests also pass. Rust sources/dependencies and inherited pnpm rules are unchanged. Generated evidence remains outside Git.

## Genuine command qualification

The command driver adds `concurrent-mutable`: four remotes, one hundred components per remote, eight versions and one 1 KiB Source per component. Its total object count matches the existing single-remote mutable-heavy case, providing a useful comparison of concurrent operation costs. The five existing workloads also remain in the comparison to check sequential overhead.

Alternating `tar-baseline,tar` commands compare separate compiled merged-base and candidate snapshots with the same helper. The base snapshot's source hashes match the merged PR #61 JavaScript graph (PR #61 only changed Rust behavior). Both snapshots are verified before and after timing; the unchanged helper is also hash-guarded. Every cold/warm command verifies full Source bytes and canonical models, versions/tags/heads and indexes. Separate diagnostics verify native coverage, zero Source hydration/fallback, zero incoming metadata inflation and successful native mutable writes. Timed commands exclude instrumentation.

Nine retained alternating fresh-process rounds per snapshot after warm-up, Linux x64, Node 24.21.0. Cold median milliseconds:

| Filesystem | Workload           | Merged base | Queued batches |
| ---------- | ------------------ | ----------: | -------------: |
| tmpfs      | many-small         |       403.2 |          408.2 |
| tmpfs      | large-compressible |       336.0 |          342.5 |
| tmpfs      | large-binary       |       345.5 |          337.2 |
| tmpfs      | mutable-heavy      |       731.6 |          726.7 |
| tmpfs      | multi-remote       |       314.1 |          315.0 |
| tmpfs      | concurrent-mutable |       682.9 |          614.1 |
| btrfs      | many-small         |       470.9 |          484.2 |
| btrfs      | large-compressible |       353.5 |          346.9 |
| btrfs      | large-binary       |       356.4 |          358.4 |
| btrfs      | mutable-heavy      |       820.1 |          812.0 |
| btrfs      | multi-remote       |       313.0 |          310.0 |
| btrfs      | concurrent-mutable |       646.8 |          623.4 |

The concurrent-mutable fixture persists the same 3,600 mutable objects with zero fallback in both modes. The baseline sends one frame per singleton caller; its older statistics do not expose a frame counter. The candidate sends 2,206 frames on tmpfs (39% fewer) and 2,075 on Btrfs (42% fewer). Single-remote mutable-heavy still sends 3,600 frames: no sequential merge policy is deferred to manufacture batching.

Concurrent-mutable Promise creations/callbacks fall from 172,706 / 104,970 to 162,150 / 96,759 on tmpfs (6% / 8%), and 169,043 / 102,924 to 158,022 / 94,324 on Btrfs (7% / 8%). Resource counts cover the entire command and vary with scheduling.

Concurrent-mutable cold wall medians improve 10.1% on tmpfs and 3.6% on Btrfs. Observed interquartile ranges are 616–947 ms versus 603–824 ms on tmpfs (substantial overlap and variation), and 639–668 versus 615–637 ms on Btrfs. The five earlier workload medians remain close, including small increases: many-small Btrfs rises 2.8%. These fixtures establish less protocol/Promise work and a workload-specific observed concurrency gain, not a uniform speedup.

CPU and memory outcomes are mixed. Concurrent-mutable median total CPU seconds / sampled RSS MiB are 1.07 / 222.7 baseline versus 1.04 / 228.7 candidate on tmpfs, and 1.08 / 230.9 versus 1.12 / 225.7 on Btrfs. Parallel compression/persistence can trade CPU for elapsed time; there is no uniform CPU or RSS saving. Warm diagnostics submit zero mutable writes, so their timing differences do not establish a batching benefit.

All six workloads on both filesystems pass full cold/warm readback and diagnostic checks. The exact committed candidate sources match the measured snapshot; the baseline source hashes match merged PR #61. The unchanged helper SHA-256 is `cee893c96e20c35c82c2e80e362c08793d215fdce02a6411eeb6f383b7d798e3`. Raw reports, provenance and logs remain outside Git in `$HOME/bit-mutable-batches-evidence-2026-10-09`. An inode-exhausted test/timing run and an earlier coordinator implementation were discarded; neither contributes to these results.

Sequential mutable batching remains separate work requiring repository visibility and ordered failure qualification. Next, measure the native worker-dispatch crossover for small coalesced frames, then consider operation orchestration and native merge/index kernels. Trusted automatic provisioning and broader platform/ACL/WAN/checkout/install qualification remain open; tar stays opt-in.

Reproduce on Linux:

```sh
TMPDIR=/tmp \
BIT_IMPORT_QUALIFICATION_TRANSPORT=http \
BIT_IMPORT_QUALIFICATION_BASELINE_CLI=/absolute/compiled-pr61 \
BIT_IMPORT_QUALIFICATION_MODES=tar-baseline,tar \
BIT_IMPORT_QUALIFICATION_ROUNDS=9 \
BIT_IMPORT_QUALIFICATION_TMPDIR=/dev/shm \
BIT_IMPORT_QUALIFICATION_REPORT=/absolute/evidence/results.json \
node --expose-gc scripts/rust-object-import/import-qualification.cjs \
  /absolute/compiled-candidate /absolute/pr61-release-helper
```

Use a Btrfs directory outside Git instead of `/dev/shm` for disk qualification. These are actual production objects-only HTTP imports, excluding WAN and checkout/install qualification. GNU time includes waited helper CPU; simultaneous process-tree RSS is sampled every 10 ms and excludes server memory, filesystem cache and staged bytes. Diagnostic stage times overlap across remote writers and are not additive.
