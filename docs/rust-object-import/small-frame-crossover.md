# Small mutable frame dispatch crossover

[PR #62](https://github.com/zkochan/bit/pull/62) coalesces requests already queued by concurrent remote writers. Singleton frames already avoid Rayon dispatch. This chunk measures whether that direct path should also handle small coalesced frames.

The selected change is deliberately bounded: exactly two objects whose **combined serialized bytes, including headers, are at most 4 KiB** persist on the serving thread. Singleton behavior remains direct at every accepted size. Three-to-sixteen-object frames and larger two-object frames retain parallel compression/persistence. Full request validation, per-object null results, ordered acknowledgements, ownership/permissions, atomic replacement and helper-exit-before-retry remain applicable. There is no protocol, JavaScript merge/index policy, dependency or default-enable change; tar stays opt-in.

## Kernel comparison

`mutable-crossover.cjs` compares two release helpers through the same production TypeScript coordinator. It measures sequential acknowledged BMP1 frames with one, two, four or eight objects and approximately 1 KiB, 8 KiB or 128 KiB JSON bodies. Bodies are deterministic and compressible. Each run uses a fresh object store, excludes eight warm frames, verifies every persisted object by decompression after timing, then reaps the helper and removes the store. One excluded round precedes five retained alternating rounds. The generated input buffers are bounded to about 64 MiB, so larger cases use fewer frames; reports record each case's actual frame count.

CPU is the sum of Node resource usage and the helper's Linux `/proc` user/system ticks while the frame loop runs. Helper ticks have 10 ms resolution on this machine. This is kernel/IPC qualification, excluding canonical merge/index policy and helper startup; the complete command comparison below includes those costs. Helper hashes are checked before and after the matrix, and reports record coordinator, harness and candidate Rust source hashes. Raw evidence stays outside Git.

An exploratory direct path for up to four objects and 64 KiB reduced CPU but increased frame latency substantially. On tmpfs, 4,096 four-object frames with approximately 1 KiB bodies took median 141.5 ms / 0.426 CPU seconds in the merged helper versus 238.8 ms / 0.244 seconds in that trial. Two-object 8 KiB frames also slowed, from 140.9 to 172.3 ms. That trial is excluded from the selected candidate and command qualification.

The selected candidate's tmpfs medians for 4,096 frames are:

| Objects / body size | Merged elapsed ms | Candidate elapsed ms | Merged CPU s | Candidate CPU s |
| ------------------- | ----------------: | -------------------: | -----------: | --------------: |
| 1 / 1 KiB           |              87.8 |                 88.5 |        0.094 |           0.101 |
| 2 / 1 KiB           |             131.3 |                135.6 |        0.326 |           0.143 |
| 4 / 1 KiB           |             147.0 |                152.3 |        0.434 |           0.451 |
| 8 / 1 KiB           |             226.3 |                240.0 |        0.689 |           0.743 |
| 2 / 8 KiB           |             150.1 |                144.7 |        0.365 |           0.359 |

Only the two-object 1 KiB case changes dispatch. Its CPU falls 56%, while elapsed time rises 3.3%; the other rows are unchanged-path controls and show measurement variation. These measurements justify a conservative CPU/latency tradeoff, not a universal compression crossover or a latency speedup. Larger payloads are retained as controls in the raw matrix.

## Complete HTTP import qualification

The same genuine compiled PR #62 CLI runs with the merged and selected release helpers. There are no production TypeScript changes, so one compiled snapshot isolates the Rust change. Both helper hashes and compiled module snapshots are verified before and after timing. Nine retained alternating fresh-process rounds follow excluded warm-up for each of six workloads on tmpfs and Btrfs, using Linux x64 and Node 24.21.0. Instrumented diagnostics are separate from timed commands.

Every cold/warm command verifies full Source bytes and canonical models, versions/tags/heads and indexes. Diagnostics verify native Source coverage, zero Source hydration/fallback and zero incoming metadata inflation. Native mutable submissions/persistence and zero fallback are checked separately. Warm imports submit no mutable writes and cannot demonstrate a dispatch gain.

Cold median milliseconds:

| Filesystem | Workload           | Merged helper | Candidate helper |
| ---------- | ------------------ | ------------: | ---------------: |
| tmpfs      | many-small         |         392.8 |            391.5 |
| tmpfs      | large-compressible |         328.1 |            329.1 |
| tmpfs      | large-binary       |         339.7 |            340.9 |
| tmpfs      | mutable-heavy      |         716.1 |            704.8 |
| tmpfs      | multi-remote       |         306.9 |            305.0 |
| tmpfs      | concurrent-mutable |         580.6 |            588.8 |
| btrfs      | many-small         |         430.9 |            421.8 |
| btrfs      | large-compressible |         337.2 |            334.4 |
| btrfs      | large-binary       |         345.9 |            348.6 |
| btrfs      | mutable-heavy      |         799.4 |            803.5 |
| btrfs      | multi-remote       |         310.3 |            310.4 |
| btrfs      | concurrent-mutable |         612.7 |            623.7 |

Concurrent-mutable total client/helper CPU medians fall from 1.00 to 0.96 seconds on tmpfs (4.0%) and 1.12 to 1.06 on Btrfs (5.4%). Observed CPU interquartile ranges are 0.98–1.03 versus 0.91–0.96 seconds on tmpfs and 1.11–1.13 versus 1.04–1.10 on Btrfs. This supports a modest workload-specific CPU reduction. It costs elapsed time: concurrent cold wall medians rise 1.4% on tmpfs and 1.8% on Btrfs, with overlapping wall interquartile ranges of 578–604 versus 580–601 ms and 606–618 versus 615–633 ms respectively. The bounded change is a CPU/latency tradeoff, not a wall-time speedup.

Both helpers persist the same 3,600 mutable objects with zero fallback. Separate concurrent diagnostics count 2,185 versus 2,121 frames on tmpfs and 2,134 versus 2,125 on Btrfs; frame density varies with scheduling even though the coordinator is identical. Consequently complete-command measurements include that scheduling effect as well as native dispatch, rather than isolating dispatch alone. Sequential mutable-heavy still sends 3,600 singleton frames, which use the unchanged direct path; its small timing/CPU differences do not demonstrate a two-object benefit.

There is no consistent memory improvement. Concurrent median sampled RSS is 226.0 versus 225.6 MiB on tmpfs and 219.0 versus 225.8 on Btrfs. Other workload timings/resources remain close with mixed directions. All six workloads on both filesystems pass full cold/warm readback and coverage checks.

All 209 applicable Node tests pass with one platform-specific skip, including a new real-helper comparison at exactly 4,096 and 4,098 combined serialized bytes and mixed per-object rejection. Exact compressed bytes and lengths match singleton writes. Canonical npm lint and Prettier pass. All 60 Rust tests, the inherited pinned formatter and warning-denied Clippy, perfectionist Dylint and rustdoc pass. Portable regression coverage is already included in the platform matrix. No generated evidence or lint exceptions are committed.

The merged helper SHA-256 is `cee893c96e20c35c82c2e80e362c08793d215fdce02a6411eeb6f383b7d798e3`; the candidate is `78d9fc435139d0c740d24ca72e43a936dca9161a5241d1773b215336aeb0df5b`. Reports, exploratory trial, packaged candidate and logs remain in `$HOME/bit-small-frame-evidence-2026-10-10` outside Git.

Reproduce the Linux-only kernel comparison:

```sh
TMPDIR=/tmp BIT_MUTABLE_CROSSOVER_TMPDIR=/dev/shm \
node --expose-gc scripts/rust-object-import/mutable-crossover.cjs \
  /absolute/merged-release-helper /absolute/candidate-release-helper \
  /absolute/evidence/crossover.json
```

Use `BIT_MUTABLE_CROSSOVER_ROUNDS` or `BIT_MUTABLE_CROSSOVER_FRAMES` to change the bounded defaults of five rounds and 4,096 frames; use an external Btrfs scratch directory instead of `/dev/shm` for disk variation. Complete command qualification:

```sh
TMPDIR=/tmp \
BIT_IMPORT_QUALIFICATION_TRANSPORT=http \
BIT_IMPORT_QUALIFICATION_BASELINE_CLI=/absolute/compiled-pr62 \
BIT_IMPORT_QUALIFICATION_BASELINE_HELPER=/absolute/merged-release-helper \
BIT_IMPORT_QUALIFICATION_MODES=tar-baseline,tar \
BIT_IMPORT_QUALIFICATION_ROUNDS=9 \
BIT_IMPORT_QUALIFICATION_TMPDIR=/dev/shm \
BIT_IMPORT_QUALIFICATION_REPORT=/absolute/evidence/results.json \
node --expose-gc scripts/rust-object-import/import-qualification.cjs \
  /absolute/compiled-pr62 /absolute/candidate-release-helper
```

GNU time includes waited helper CPU. Simultaneous process-tree RSS is sampled every 10 ms and excludes server memory, filesystem cache and staged bytes. This is local production objects-only HTTP qualification, excluding WAN and checkout/install. Other payload entropy, platforms, ACLs and storage contention can shift the dispatch tradeoff.

Next, profile the remaining canonical merge/index work and select a bounded native kernel only after qualifying visibility, cross-remote ordering and acknowledged-prefix failures. Sequential mutable batching, trusted automatic provisioning and broader platform/ACL/WAN/checkout/install qualification remain open.
