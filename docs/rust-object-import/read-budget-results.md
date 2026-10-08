# Budgeting native raw-read operations

The native raw reader previously attempted up to 32 MiB of response transfer before falling back and reading the entire operation again in Node. For medium compressed files, pipe transfer and the discarded attempt can cost more than canonical reads. The new BRC1 request checks eligible file sizes in Rust before sending contents. A batch exceeding 4 MiB of eligible bytes, or containing no eligible files, returns no accepted response and immediately selects canonical reads.

Requests contain at most 4,096 hashes with identity 1. Accepted operations retain the existing ordered BRD1 responses in 128-file frames, including missing/oversized per-file fallback. Individual files remain limited to 256 KiB. Duplicate requests count toward the budget. The stat audit is advisory, not a filesystem snapshot: files can change afterward, and the existing 32 MiB plus framing hard response cap and complete-operation fallback still apply. Hooks, custom methods, Ref identity, permissions, missing-object errors and Windows read eligibility are unchanged. Old helpers reject BRC1 and retain Node fallback.

`BIT_RUST_OBJECT_READ_BUDGET=off` restores the previous raw-read framing. Normal helper selection remains opt-in through `BIT_RUST_OBJECT_IMPORT`; this does not change Source validation/persistence, headers, traversal or merge policy.

## Measured decision

A larger streaming prototype was rejected. At 1,024 opaque 512 KiB files on tmpfs, medians were 42.2 ms for Node, 58.9 ms for the preceding native path and 218.1 ms for streaming. The streaming path removed Node filesystem requests but required four helpers and expensive pipe copying. Prototype code and raw evidence stay outside Git. Larger streaming reads remain an open task.

The replacement was measured through the rebuilt private CLI's actual `Repository.loadManyRaw()`, with ordered Ref identity and SHA-256 byte verification. Nine alternating rounds follow warm-up, Linux x64/Node 24.21.0, warmed tmpfs and Btrfs, 1,024 distinct files. Timings cover the API call; verification occurs afterward. Opaque bytes isolate the compressed-byte read API, which does not decode file contents. These are stage measurements, not whole import-command gains or cold-disk results.

| Bytes per file | Btrfs Node (ms) | Previous native (ms) | Checked native (ms) |
| -------------- | --------------: | -------------------: | ------------------: |
| 64             |            6.24 |                 2.41 |                2.66 |
| 1,024          |            6.18 |                 3.69 |                3.77 |
| 4,096          |            6.19 |                 4.99 |                5.40 |
| 16,384         |            6.22 |                10.75 |                8.91 |
| 65,536         |            5.82 |                29.52 |               11.42 |
| 524,288        |           53.97 |                68.63 |               66.21 |

At 64 KiB, the checked operation is 61–65% faster than the previous native path across Btrfs/tmpfs. It still costs more than direct Node reads because it starts a helper and audits files first. Small eligible batches retain zero Node filesystem requests and one helper, with roughly 0.03–0.41 ms of added audit cost in these probes. Budget rejection retains 4,096 canonical filesystem requests and one helper. The 512 KiB difference is small and is not treated as a benefit. Fewer callbacks alone do not establish improved latency, CPU or memory.

## Reproduction and remaining qualification

Use a separate compiled private CLI rebuilt with the current coordinator. Keep generated files outside the checkout:

```sh
BIT_LEGACY_ROOT="$HOME/bit-test-distribution" \
BIT_TEST_OBJECT_IMPORT="$PWD/native/target/release/bit-object-import" \
BIT_READ_BUDGET_REPORT=/tmp/bit-read-budget.json \
node --expose-gc scripts/rust-object-import/read-budget-benchmark.cjs
```

`BIT_READ_BUDGET_TMPDIR` selects another filesystem. `BIT_DIRECTORY_PROFILE=1` additionally uses the shared fresh-process profiler for the 64 KiB case, recording whole Node/helper CPU and sampled process-tree RSS over repeated operations. Raw reports, fixtures and the rejected streaming prototype are external evidence.

Correctness coverage includes the inclusive byte boundary, rejection above it, empty/missing files, rollback, malformed identities/counts/truncated requests, packaged discovery and canonical repository tests. Full-command and whole-client resource qualification are recorded with the PR once completed. No claim of larger-file support, Windows performance, complete Rust parity or a generally faster raw reader is made.
