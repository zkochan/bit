# Local object persistence measurements — 2026-10-08

Linux x64, AMD Ryzen 9 9950X3D2, Node 24.21.0, Rust 1.97.0 release helper. Fixture/destination directories were on local Btrfs. Existing model/repository graph came from the isolated Bit build at `a72e7cb66dd52be1c86aacb8745296fa5147b461`; current feature stream, queue, validator and repository Source writer were loaded by the standalone test harness. Native executable SHA-256: `9f1fe4e7605fc744daaf7c7277f573e021e5904af76979fd091a64a53cbfd5c6`.

Nine fresh-process interleaved rounds per mode after an excluded warm-up. The same received compressed bytes are used in every mode. Each run persists into a fresh repository, then loads and verifies every content hash. The process wall time includes startup, helper transfer/startup, persistence and subsequent reads; it is not a whole `bit import` measurement. Local filesystem caches were not forcibly dropped. Disk capacity and network transfer were not simulated.

## Median wall time (milliseconds)

| Fixture                          | Mode                         | Persist | Persist + subsequent reads | Process incl. startup |
| -------------------------------- | ---------------------------- | ------: | -------------------------: | --------------------: |
| 5,000 × 1 KiB Sources            | Legacy                       |   563.0 |                      732.6 |                1049.0 |
|                                  | JS compressed-buffer control |   409.7 |                      582.0 |                 903.7 |
|                                  | Rust Source validation       |   385.8 |                      568.9 |                 889.4 |
| 32 × 8 MiB compressible Sources  | Legacy                       |   651.3 |                     1030.7 |                1350.3 |
|                                  | JS compressed-buffer control |   253.5 |                      580.9 |                 894.6 |
|                                  | Rust Source validation       |   178.7 |                      523.4 |                 843.3 |
| 16 × 4 MiB random binary Sources | Legacy                       |  1613.1 |                     1690.2 |                1999.1 |
|                                  | JS compressed-buffer control |   103.6 |                      168.5 |                 482.2 |
|                                  | Rust Source validation       |    88.6 |                      167.6 |                 481.7 |

Most of the legacy improvement comes from avoiding recompression. Rust adds a 29.5% persistence-time reduction and 5.7% startup-inclusive reduction over the JS control for large compressible Sources. The small/binary cases show little additional startup-inclusive benefit (1.6%/0.1%); these differences should not be promoted as established full-command gains. A preceding independent nine-round run showed the same pattern (large-compressible process: legacy 1345 ms, control 900 ms, native 836 ms).

## CPU and memory

GNU time CPU is user + system time for the command and waited-for descendants, including the helper. RSS is a near-simultaneous sampled sum for the process tree at 10 ms; it counts shared pages in each process. Persistence-stage memory includes module startup and stops when persistence completes; whole-process memory also includes subsequent reads. Separate samplers can differ slightly in their sampled maxima. All 81 retained CPU/memory runs had zero failed `/proc` reads; process-exit races are separately recorded.

| Fixture            | Mode       | Total CPU (s) | Persistence-stage peak RSS (MiB) | Whole-process peak RSS (MiB) |
| ------------------ | ---------- | ------------: | -------------------------------: | ---------------------------: |
| Many small         | Legacy     |          1.64 |                            267.8 |                        277.7 |
|                    | JS control |          1.40 |                            219.5 |                        255.4 |
|                    | Rust       |          1.45 |                            202.3 |                        227.8 |
| Large compressible | Legacy     |          2.35 |                            249.1 |                        429.1 |
|                    | JS control |          1.44 |                            245.5 |                        452.7 |
|                    | Rust       |          1.27 |                            172.9 |                        448.1 |
| Large binary       | Legacy     |          2.61 |                            310.1 |                        310.0 |
|                    | JS control |          0.87 |                            267.8 |                        267.8 |
|                    | Rust       |          0.83 |                            236.7 |                        270.2 |

Native streaming reduces persistence-stage residency, but later Source rehydration removes much of this gain for large objects. Whole-process memory does not consistently improve relative to legacy/control; small-object CPU also rises slightly versus the control. The helper defaults to four workers, but a single serialized remote stream produces one-object batches, so these results do not demonstrate parallel batch scaling.

## Validation and remaining work

The tests exercise Source content/readback parity, Unicode/binary/empty/large content, wrong identities, corruption/truncation/checksums/trailing data, mutable history merges and component collection, duplicate imports, persist hooks, cache invalidation, existing file mode, failed writes, bounds, protocol corruption, missing/crashed/hung helpers and actual ObjectFetcher lifecycle with in-memory remote streams.

Keep the prototype opt-in. Before rollout: full cold `bit import` and representative commands against real scopes, mutable-heavy and multi-remote loads, warm reuse/rehydration, network/merge/queue breakdowns, slower storage, additional platform execution and packaged distribution. The JS control may be the first broadly useful optimization even where native startup/IPC is not worthwhile.

Raw JSON evidence is stored outside Git in `/var/home/zoltan/bit-object-import-evidence-2026-10-08/` on the development machine. Drivers regenerate disposable fixtures/results; no large result files or profiles are committed.
