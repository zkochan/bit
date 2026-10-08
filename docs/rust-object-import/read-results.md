# Bounded object reads and header classification

Measured on Linux x64, Node 24.21.0, release helper, nine interleaved rounds after excluded warm-up. These use the actual current Repository APIs and compare ordered Ref identities and bytes/classification metadata. Timings include helper startup/exit, framing, output parsing and readback assertions; Node/module-loader startup is outside the timer. Header benchmarks supply the known Ref inventory, so directory traversal is outside their timings. Files contain small compressed Source representations.

| Filesystem | Operation | Objects | Node ms | Rust ms | Reduction | Node filesystem requests |
| ---------- | --------- | ------: | ------: | ------: | --------: | -----------------------: |
| tmpfs      | reads     |   1,024 |    9.19 |    3.44 |     62.6% |                4,096 → 0 |
| tmpfs      | reads     |   4,096 |   22.99 |    7.13 |     69.0% |               16,384 → 0 |
| tmpfs      | headers   |   1,024 |   13.72 |    3.78 |     72.4% |                4,096 → 0 |
| tmpfs      | headers   |   4,096 |   42.68 |    9.15 |     78.6% |               16,384 → 0 |
| Btrfs      | reads     |   1,024 |    6.76 |    3.38 |     50.0% |                4,096 → 0 |
| Btrfs      | reads     |   4,096 |   25.53 |    7.38 |     71.1% |               16,384 → 0 |
| Btrfs      | headers   |   1,024 |   11.50 |    3.94 |     65.7% |                4,096 → 0 |
| Btrfs      | headers   |   4,096 |   45.71 |    9.56 |     79.1% |               16,384 → 0 |

These are API-stage latency measurements, not whole-command import speedups or measurements of complete large-file reads. Diagnostic filesystem requests are recorded separately and cover the operation, excluding header directory traversal. Node zlib/model parsing for loaded buffers remains canonical. Per-process CPU/RSS for these kernel probes was not measured, so lower latency/callback counts must not be interpreted as a CPU or memory reduction.

The first raw-read prototype launched one helper per 128 objects and was slower than Node. The qualified version feeds bounded frames through one process for a group of up to 4,096 hashes. Each frame still caps Rust reads at 128 files/256 KiB per compressed file; combined output is capped at 32 MiB plus framing allowance. Large or unreadable individual files fall back to scalar reads. A transfer exceeding the group response bound discards the operation and uses canonical Node reads. The helper slot retains no completed response.

Header classification reads only 512 compressed bytes per file, drains that whole prefix to preserve corruption behavior, retains at most a 256-byte header and uses reusable 64 KiB inflate chunks. It is type classification, not complete object-integrity validation. Node retains dynamic registered-type policy and canonical unreadable reporting. Neither path introduces a filesystem cache or promises an atomic snapshot. Windows, active/custom read transforms, custom scalar/path methods and short/noncanonical hashes retain Node processing.

## Correctness qualification

The actual compiled CLI's object APIs were checked in genuine import scopes with 2,048 Sources plus a Version/component/history. Complete compressed-byte readback matches. Instrumentation confirms native reads for all 2,048 Sources and native headers for all 2,051 objects; type, size and modification time match canonical results. Directory traversal order can vary between calls, so the scope-level comparison normalizes by hash; separate repository tests retain a fixed Ref inventory and check exact ordering/Ref identity. Cold/repeated artifact imports, deletion repair, missing-object errors, duplicate requests and missing-helper fallback pass.

File and loopback HTTP `bit import --objects` smoke checks also preserve full Source/model/history/head/tag/index readback across five modes and missing/crashing-helper fallback. Their small groups remain below read/header thresholds, so these command checks establish compatibility rather than native-stage coverage or a command speedup. The explicit compiled API checks above establish stage coverage.

All 56 Node tests and 38 Rust workspace tests pass, along with strict coordinator TypeScript, canonical `npm run lint` in the isolated rebuilt CLI and inherited pnpm formatter/Clippy/perfectionist checks without new exceptions. Coverage includes binary/empty/bounded files, oversized group fallback, malformed protocol identities/lengths/statuses, corrupt/truncated prefixes, every-byte prefix mutations, unknown types, `ENOENT` versus permission errors, custom read hooks, ordered deduplication and full fallback.

Raw evidence/fixtures/logs remain outside Git on the development machine (`reads-tmpfs.json`, `reads-btrfs.json`, `reads-command-smoke.json`, `reads-http-smoke.json`). Only compact Markdown and drivers are committed.

```sh
BIT_LEGACY_ROOT=/tmp/prepared-bit-cli \
  BIT_READ_REPORT="$HOME/bit-read-evidence.json" \
  node --expose-gc scripts/rust-object-import/reader-benchmark.cjs
# Set BIT_READ_TMPDIR to an external directory for disk variation.
node scripts/rust-object-import/reader-import-qualification.cjs \
  /tmp/object-import-cli "$PWD/native/target/release/bit-object-import"
```
