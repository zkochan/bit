# Grouped read-only helper operations

Linux x64, Node 24.21.0, release helper, actual rebuilt `Repository.hasMultiple()` and explicit-Ref `listObjectsWithType()` callers. Nine interleaved rounds after excluded warm-up, tmpfs and Btrfs. Both modes select the native helper; the previous mode sends one 4,096-hash frame per process, while grouped operations send up to four frames in one process. Timings include helper startup/exit, splitting, complete response validation, result construction and ordered Ref/type/size verification. Model-loader startup and fixture creation are outside these API timings. Source fixtures are small compressed buffers; these are metadata/existence measurements, not large-file transfer measurements.

| Filesystem | Operation | Hashes | Previous ms | Grouped ms | Reduction |
| ---------- | --------- | -----: | ----------: | ---------: | --------: |
| tmpfs      | exists    |  4,096 |        3.06 |       2.91 |      4.9% |
| tmpfs      | headers   |  4,096 |        7.92 |       7.49 |      5.4% |
| tmpfs      | exists    | 16,384 |       10.13 |       6.91 |     31.8% |
| tmpfs      | headers   | 16,384 |       31.42 |      26.36 |     16.1% |
| btrfs      | exists    |  4,096 |        2.76 |       2.84 |     -2.9% |
| btrfs      | headers   |  4,096 |        8.28 |       8.08 |      2.4% |
| btrfs      | exists    | 16,384 |       10.73 |       7.61 |     29.1% |
| btrfs      | headers   | 16,384 |       31.37 |      27.87 |     11.2% |

At 16,384 hashes, helper launches and completion callbacks fall from four to one. Separate async-resource diagnostics verify exactly those process counts and zero Node filesystem requests in both modes. At 4,096 hashes both modes perform the same single-frame operation; small timing differences are noise, not an established improvement. The grouped size is bounded to 16,384 hashes, with frame/request identities preserved and whole-operation fallback on any missing/extra/reordered/corrupt frame, helper error, timeout or response overflow. Header output remains capped at 8 MiB. Raw compressed-buffer reads and streaming directory inventories retain their existing grouping.

Fresh Node workers each classify the known 16,384-Ref list 32 times. Nine interleaved runs follow excluded warm-up. GNU time includes Node and reaped helper CPU; Linux `/proc` samples the near-simultaneous sum of process-tree RSS every 5 ms. These timings include worker/model-loader startup, all helper invocations and result checks, with normal GC during the repetitions and exposed GC once before them. Fixture generation and the monitoring parent are excluded.

| Filesystem | Metric                            | Previous | Grouped |
| ---------- | --------------------------------- | -------: | ------: |
| tmpfs      | Worker elapsed ms                 |  1024.92 |  886.41 |
| tmpfs      | Node + helper CPU seconds         |     2.46 |    2.23 |
| tmpfs      | Sampled peak process-tree RSS MiB |   258.28 |  247.07 |
| btrfs      | Worker elapsed ms                 |  1069.86 |  946.72 |
| btrfs      | Node + helper CPU seconds         |     2.63 |    2.46 |
| btrfs      | Sampled peak process-tree RSS MiB |   239.86 |  256.55 |

Whole-client CPU improves on both filesystems in this repeated header workload. Sampled RSS falls on tmpfs and rises on Btrfs; no consistent memory improvement is established. Larger grouped responses can increase transient Node allocations despite the unchanged header-output cap. Sampling can miss short-lived peaks and is not a guaranteed memory bound. Restore one frame per helper with `BIT_RUST_OBJECT_READ_OPERATIONS=off`. No long-lived helper or filesystem cache is introduced.

A genuine compiled remote with 16,384 Sources confirms complete 16,387-object header parity, exact Source byte reads, cold/repeated artifact imports, deletion repair and missing-helper fallback. Instrumentation observes native existence responses for all 16,384 hashes: zero present on cold import, 16,384 on repetition and 16,383 after deletion. File and original loopback HTTP/tar `bit import --objects` smoke checks preserve full Source/model/history/head/tag/index readback and missing/crashing-helper fallback. Their small inventories do not establish a grouped-operation whole-command speedup.

Validation: 72 Node tests, 95 compiled object unit tests with explicit GC, 40 Rust workspace tests, strict coordinator TypeScript, canonical isolated `npm run lint`, and inherited pnpm formatter/Clippy/perfectionist checks pass. Protocol tests include a missing/reordered/extra frame, invalid later headers, crossing the 16,384-hash operation boundary and independent rollback. The Rust wire protocol already supports repeated frames; this change uses it at the operation boundary without changing formats, hydration, mutable policies, custom overrides or Ref identity. The two previously documented normal Bit source-runner class-identity failures remain separate from the passing compiled suite.

Raw reports/logs/fixtures stay outside Git in the development machine's `bit-object-read-operation-evidence-2026-10-08` directory. Reproduction:

```sh
BIT_LEGACY_ROOT=/tmp/prepared-current-cli \
  BIT_READ_OPERATION_REPORT="$HOME/read-operation-evidence.json" \
  node --expose-gc scripts/rust-object-import/read-operation-benchmark.cjs
# Add BIT_DIRECTORY_PROFILE=1 for Linux whole-client CPU/RSS measurements.
# Set BIT_READ_OPERATION_TMPDIR to an external disk directory for storage variation.
BIT_RUST_OBJECT_TRAVERSAL=off BIT_READ_QUALIFICATION_FILES=16384 \
  node scripts/rust-object-import/reader-import-qualification.cjs \
  /tmp/prepared-current-cli "$PWD/native/target/release/bit-object-import"
```
