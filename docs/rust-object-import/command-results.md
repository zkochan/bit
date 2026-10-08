# Real object-import command qualification

Measured 2026-10-08 on Linux x64, Node 24.21.0, privately compiled Bit 2.2.93. Destinations and local file remotes are on tmpfs. These are startup-inclusive `bit import --objects --skip-dependency-installation --json --safe-mode` commands, with `--all-history` for cold imports. Each mode has nine interleaved fresh-workspace runs after an excluded warm-up. Cold means an empty destination object store; it does not mean cleared OS caches. GNU time includes the helper CPU, and sampled process-tree RSS includes the helper. Independent readback checks all Source bytes, identities, models, tags, heads, histories and component index entries.

The CLI is a physical private copy of the prepared graph at `a72e7cb66dd52be1c86aacb8745296fa5147b461`, with this branch’s affected Sources compiled by Bit’s normal compiler. Raw reports include source and compiled-module SHA-256 identities. The frozen original CLI, `rust` branch and user lockfile were unchanged.

| Workload           | Objects | JS legacy ms | JS raw-buffer control ms | Rust validation / Node writes ms | Rust validation + persistence ms | Native improvement vs control |
| ------------------ | ------: | -----------: | -----------------------: | -------------------------------: | -------------------------------: | ----------------------------: |
| many-small         |    2900 |        678.0 |                    592.7 |                            574.6 |                            468.6 |                         20.9% |
| large-compressible |      96 |        962.8 |                    553.0 |                            337.9 |                            327.7 |                         40.7% |
| large-binary       |      96 |       1970.9 |                    357.2 |                            329.2 |                            312.1 |                         12.6% |
| mutable-heavy      |    4400 |       1228.4 |                   1198.8 |                           1445.7 |                           1236.4 |                         -3.1% |
| multi-remote       |      96 |        677.0 |                    466.6 |                            305.4 |                            328.3 |                         29.6% |

Many-small has 2,500 1 KiB Sources; large-compressible has 32 8 MiB Sources (256 MiB); large-binary has 64 MiB of deterministic binary content plus small main files; mutable-heavy has 400 components with eight Versions each and 400 small Sources; multi-remote splits 256 MiB across two scopes. All workloads include genuine component/Version/history merges and index checks. Native diagnostic runs acknowledged every expected Source with zero write fallbacks.

| Workload           | Control CPU seconds | Native CPU seconds | Control peak RSS MiB | Native peak RSS MiB | Control repeated import ms | Native repeated import ms |
| ------------------ | ------------------: | -----------------: | -------------------: | ------------------: | -------------------------: | ------------------------: |
| many-small         |                0.85 |               0.70 |                219.5 |               186.9 |                      279.4 |                     284.4 |
| large-compressible |                0.81 |               0.52 |                223.8 |               149.8 |                      240.9 |                     249.3 |
| large-binary       |                0.52 |               0.46 |                259.5 |               226.0 |                      239.8 |                     238.6 |
| mutable-heavy      |                1.83 |               1.91 |                287.4 |               296.3 |                      455.1 |                     463.3 |
| multi-remote       |                0.75 |               0.50 |                243.5 |               147.1 |                      244.0 |                     244.3 |

Repeated imports correctly process zero Sources through the helper; native gains apply to cold local object processing. Mutable-heavy native persistence is 3.1% slower than the control here, and validation-only is considerably slower: metadata still pays native request overhead and then canonical JavaScript parsing/merging. Keep this limitation visible and retain opt-in selection. Large-byte gains include avoiding Node inflation; many-small gains show the additional benefit of native atomic writes. Most legacy-to-native binary gains come from compressed-buffer reuse, already available in the JS control.

Separate diagnostic commands count Node async resources and callbacks; wrappers add Promise overhead, so these are comparative diagnostic counts rather than exact uninstrumented totals. Inclusive stage sums overlap and must not be interpreted as an elapsed-time breakdown.

| Many-small cold diagnostic | JS control | Rust validation / Node writes | Rust validation + persistence |
| -------------------------- | ---------: | ----------------------------: | ----------------------------: |
| Filesystem callbacks       |      29553 |                         29154 |                         16209 |
| Promise callbacks          |      87831 |                         82352 |                         38793 |
| Zlib callbacks             |       7606 |                          2406 |                          2406 |

Native persistence commits 2,500 Sources in 367 batches, with no per-Source Node atomic writer calls. For many-small the filesystem callback count falls about 45% and Promise callbacks about 56% versus the JS control. File-remote command counts also include local-server traversal/read work, which remains JavaScript.

Validation: 41 Node transport/persistence/hook/cache/fetcher/diagnostic tests pass with zero skips; 36 Rust workspace tests pass; the exact inherited pnpm formatter, Clippy and perfectionist checks pass without new lint exceptions. Cross-platform CI runs the native store/transport tests, while full repository/command tests require the privately bootstrapped graph and are locally verified. Windows retains Node persistence pending native metadata/atomic-write qualification.

The original measurement attempt retained verified scopes in the harness parent’s global cache. Its results were discarded. This run clears only that private readback cache, with exposed GC between commands; production CLI processes use normal caches and GC. Raw JSON and logs remain outside Git on the development machine; the accepted file-remote report is `native-store-real-import-bounded-verification.json`. Earlier PR #34 writer-only results retain their original scope in [local-results.md](./local-results.md).

HTTP/tar qualification uses the compiled FetchRoute and original tar encoder/decoder on loopback. It exercises the real HTTP client path but excludes authentication, WAN latency and server-process CPU/memory. Native helper distribution, Windows metadata behavior, varied storage and default rollout remain separate work.

## Loopback HTTP/tar commands

The same nine-round, four-mode protocol was repeated for three representative workloads through Bit’s real HTTP client, compiled FetchRoute and original tar encoder/decoder. The server is a separate, unmeasured process; client wall time includes loopback transfer/waiting, and client CPU/RSS includes its Rust helper. Every cold/warm repository passed the same complete readback.

| Workload           | JS control ms | Validation / Node writes ms | Native persistence ms | Native improvement vs control | Control CPU seconds | Native CPU seconds |
| ------------------ | ------------: | --------------------------: | --------------------: | ----------------------------: | ------------------: | -----------------: |
| many-small         |         568.4 |                       563.6 |                 461.5 |                         18.8% |                0.80 |               0.66 |
| large-compressible |         549.1 |                       351.3 |                 343.6 |                         37.4% |                0.80 |               0.53 |
| multi-remote       |         492.3 |                       336.8 |                 355.8 |                         27.7% |                0.82 |               0.55 |

Many-small client filesystem callbacks fall from 16,220 to 2,952 (81.8%); diagnostic Promise callbacks fall from 72,164 to 23,185 (67.9%). Source commits no longer create Node filesystem requests. For the large multi-remote case, validation-only beats native persistence by about 19 ms in this run: moving the writer into Rust has its largest measured benefit when object counts are high. Do not claim that every extra native stage always wins.

Missing/crashing-helper HTTP smoke imports also preserve complete repository contents; ordinary repeated imports process zero native Sources. These tests do not cover production authentication, WAN conditions, HTTP retry/failure injection or checkout/dependency installation. Raw reports remain outside Git on the development machine (`native-store-http-import-bounded-verification.json` and `native-store-http-smoke.json`).

## Ordinary local disk

Nine interleaved rounds per mode were repeated on Btrfs (`statfs` type `0x9123683e`) for many-small, large-compressible and mutable-heavy file-remote imports. Remote fixtures and destination workspaces both use that filesystem. All readback, repeated-command and native commit coverage checks pass. This uses normal OS caching, without dropping caches or making durability/fsync claims.

| Workload           | JS control ms | Validation / Node writes ms | Native persistence ms | Native improvement vs control | Control CPU seconds | Native CPU seconds |
| ------------------ | ------------: | --------------------------: | --------------------: | ----------------------------: | ------------------: | -----------------: |
| many-small         |         972.9 |                       829.3 |                 646.5 |                         33.6% |                1.23 |               0.96 |
| large-compressible |         590.3 |                       351.7 |                 340.3 |                         42.3% |                0.90 |               0.53 |
| mutable-heavy      |        1413.2 |                      1703.5 |                1397.6 |                          1.1% |                2.17 |               2.17 |

Raw evidence is outside Git on the development machine (`native-store-btrfs-import-bounded-verification.json`). These results establish gains on two local filesystem types; they do not establish behavior on deployment network filesystems or full checkout/package-install commands. Metadata-heavy workloads remain a separate optimization target.
