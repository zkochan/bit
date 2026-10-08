# Batched metadata inflation in Rust

Measured 2026-10-08, Linux x64/Node 24.21.0/tmpfs, genuine compiled object-only Bit imports. Nine interleaved fresh destinations per mode after excluded warm-up; repeated commands and complete Source/model/history/head/tag/index readback match. Five modes isolate the additional metadata stage from PR #35’s Source persister, validation-only and the raw-buffer JavaScript control. CPU/RSS include the helper; diagnostic callbacks are separately instrumented.

| Workload           | JS control ms | Source persister ms | Source + metadata ms | Metadata gain over Source persister | Source persister CPU s | Source + metadata CPU s |
| ------------------ | ------------: | ------------------: | -------------------: | ----------------------------------: | ---------------------: | ----------------------: |
| many-small         |         617.7 |               484.7 |                477.4 |                                1.5% |                   0.72 |                    0.72 |
| large-compressible |         536.1 |               322.7 |                321.5 |                                0.4% |                   0.50 |                    0.51 |
| mutable-heavy      |        1203.4 |              1286.8 |               1180.4 |                                8.3% |                   2.00 |                    1.81 |

The mutable-heavy workload has 4,400 objects, including 400 Sources and 4,000 component/Version/history objects. Rust inflation is 8.3% faster than the Source-only persister here, but only 1.9% faster than the JS control. Most remaining time belongs to canonical JavaScript merge/persistence and local-server traversal; this is an incremental processing gain, not a completed mutable-store rewrite. Small gains on Source-heavy workloads should not be treated as significant standalone wins.

| Diagnostic workload | Metadata inflated by Rust | Source-only Node zlib callbacks | Source + metadata Node zlib callbacks |
| ------------------- | ------------------------: | ------------------------------: | ------------------------------------: |
| many-small          |                       401 |                            2406 |                                  1604 |
| large-compressible  |                        65 |                             390 |                                   260 |
| mutable-heavy       |                      4001 |                           24806 |                                 16804 |

The helper returns bounded, losslessly decoded inflated metadata to the unchanged Bit model parser. It does not parse/rewrite model JSON or validate mutable identity using Source hash rules. Unknown types and malformed JSON retain canonical parser errors. Invalid UTF-8, corrupt/truncated/trailing zlib streams and metadata above 256 KiB retain legacy inflation. The coordinator validates full response identity and byte counts before processing; metadata can never authorize a native Source commit. Input/output bounds and failure fallback remain in place. Response accumulation now concatenates chunks once, avoiding repeated copying when metadata responses span many chunks.

Native persistence uses `BOI3`/`BOC3`; `BIT_RUST_OBJECT_IMPORT_METADATA=off` retains the PR #35 `BOI2`/`BOC2` Source-only path. `BIT_RUST_OBJECT_IMPORT_MODE=validate` retains Source-only native validation with Node writes. Default selection remains off; custom transforms and Windows preserve the existing compatibility path.

Validation: 43 Node tests and 38 Rust workspace tests pass, as do strict coordinator TypeScript and the exact inherited pnpm Rust formatter/Clippy/perfectionist rules without new exceptions. Real-import smoke includes missing/crashing-helper fallback and byte/model/index parity. Raw JSON/logs/fixtures stay outside Git on the development machine (`metadata-real-import.json`). The frozen prepared CLI and original `rust` branch are unchanged.

## Loopback HTTP qualification

Nine interleaved rounds per mode also passed through Bit’s real FetchRoute and tar encoder/decoder. All 2,900 many-small and 4,400 mutable-heavy objects passed full cold/repeated-import readback. Client measurements include the helper and exclude the remote server.

| Workload      | JS control ms | Source persister ms | Source + metadata ms | Metadata gain over Source persister | Source persister CPU s | Source + metadata CPU s |
| ------------- | ------------: | ------------------: | -------------------: | ----------------------------------: | ---------------------: | ----------------------: |
| many-small    |         600.7 |               475.4 |                474.6 |                                0.2% |                   0.69 |                    0.69 |
| mutable-heavy |        1062.2 |              1110.2 |               1016.7 |                                8.4% |                   1.60 |                    1.44 |

The HTTP mutable-heavy result is 4.3% faster than the JavaScript control. Source-heavy elapsed time is effectively unchanged by this extra stage. These object-only local-server measurements exclude checkout, dependency installation, authentication and WAN latency. Raw evidence remains outside Git (`metadata-http-import.json`).
