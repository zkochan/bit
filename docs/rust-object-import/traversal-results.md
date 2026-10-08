# Native directory traversal and combined inventories

Linux x64, Node 24.21.0, release helper, actual rebuilt `Repository.listRefs()` and `listObjectsWithType()`. Nine interleaved rounds after excluded warm-up on tmpfs and Btrfs. Both comparison modes select the native helper: the previous path keeps Node glob traversal and existing native header batches; the new path moves traversal and optional classification into one Rust process. Timings include root preflight, helper startup/exit, returned result construction and hash-set/type/size verification. Compiler/model-loader startup and fixture creation are outside these API timings. Fixtures contain small compressed Source objects spread over all 256 canonical prefix directories.

| Filesystem | Operation | Objects | Previous ms | Traversal ms | Reduction |
| ---------- | --------- | ------: | ----------: | -----------: | --------: |
| tmpfs      | refs      |     256 |        2.47 |         2.13 |     13.7% |
| tmpfs      | headers   |     256 |        5.01 |         2.74 |     45.3% |
| tmpfs      | refs      |   4,096 |        6.60 |         5.22 |     20.9% |
| tmpfs      | headers   |   4,096 |       17.10 |        10.54 |     38.3% |
| tmpfs      | refs      |  16,384 |       15.94 |        11.29 |     29.2% |
| tmpfs      | headers   |  16,384 |       51.88 |        35.88 |     30.8% |
| btrfs      | refs      |     256 |        2.72 |         2.54 |      6.8% |
| btrfs      | headers   |     256 |        4.98 |         2.61 |     47.6% |
| btrfs      | refs      |   4,096 |        7.85 |         5.24 |     33.3% |
| btrfs      | headers   |   4,096 |       16.97 |        11.15 |     34.3% |
| btrfs      | refs      |  16,384 |       15.94 |        10.37 |     35.0% |
| btrfs      | headers   |  16,384 |       53.01 |        34.52 |     34.9% |

Separate async-resource diagnostics count 258 → 1 Node filesystem requests for every measured inventory. The remaining request checks the root layout. Prefixes share frames of up to 4,096 objects; classifying each prefix in a separate frame initially erased much of the benefit, so the final implementation groups entries across prefixes. Production selects only stores with all 256 canonical prefixes; narrower layouts retain Node.

For whole-client resource measurements, fresh Node workers each classify the 16,384-object inventory 32 times. Nine interleaved runs follow excluded warm-up. GNU time includes Node and reaped helper CPU; Linux `/proc` samples the near-simultaneous sum of process-tree RSS every 5 ms. Timings below include worker/model-loader startup, result checks, all helper invocations and ordinary production GC. They exclude fixture generation and the monitoring parent. GC is exposed once before the repeated operations, not between them.

| Filesystem | Metric                            | Previous | Traversal |
| ---------- | --------------------------------- | -------: | --------: |
| tmpfs      | Worker elapsed ms                 | 1,506.01 |  1,099.95 |
| tmpfs      | Node + helper CPU seconds         |     3.52 |      3.15 |
| tmpfs      | Sampled peak process-tree RSS MiB |    355.4 |     272.5 |
| Btrfs      | Worker elapsed ms                 | 1,588.12 |  1,114.02 |
| Btrfs      | Node + helper CPU seconds         |     3.77 |      3.24 |
| Btrfs      | Sampled peak process-tree RSS MiB |    372.0 |     292.6 |

These are repeated inventory workload results, not complete Bit-command or large-Source-content improvements. Sampled RSS can miss short-lived peaks and is not a guaranteed memory bound. No inventory cache is added.

Genuine compiled scope qualification confirms that a 2,048-Source remote's complete 2,051-object inventory uses combined native traversal/classification and matches canonical type/size/mtime and unreadable reporting. Existing compiled raw reads, cold/repeated artifact import, deletion repair and missing-helper fallback retain byte parity. Full file and original loopback HTTP/tar `bit import --objects` smoke checks pass with complete Source/model/history/head/tag/index readback and missing/crashing helpers. Their small layouts stay below the traversal threshold, so these command checks establish compatibility rather than traversal speedups.

Validation: 70 Node tests, 40 Rust workspace tests, 95 compiled object unit tests with explicit GC, strict coordinator TypeScript, canonical `npm run lint` in the private rebuilt CLI, and the inherited pnpm formatter/Clippy/perfectionist/rustdoc checks pass without new exceptions. New differential/lifecycle tests cover multiple frames, late invalid-layout fallback, hidden paths, uppercase paths, leaf directories/symlinks, symlinked prefixes, permissions, creation/deletion, overrides/transforms, malformed/truncated/duplicate/oversized/trailing responses, nonzero exits and actual failed-helper reaping. The normal Bit source runner's two pre-existing repository class-identity failures remain documented in [mutable-results.md](./mutable-results.md); the compiled suite passes.

Raw fixtures, JSON and logs stay outside Git in the development machine's `bit-object-traversal-evidence-2026-10-08` directory. The compact tables above use `traversal-tmpfs.json` and `traversal-btrfs.json`; resource measurements use `traversal-tmpfs-profiled.json` and `traversal-btrfs-profiled.json`. Reproduction:

```sh
# First prepare a physical private CLI with the current affected components.
node scripts/rust-object-import/prepare-cli.cjs /tmp/prepared-bit-cli /tmp/traversal-cli
BIT_LEGACY_ROOT=/tmp/traversal-cli \
  BIT_DIRECTORY_REPORT="$HOME/traversal-evidence.json" \
  node --expose-gc scripts/rust-object-import/directory-benchmark.cjs
# Add BIT_DIRECTORY_PROFILE=1 for Linux process-tree CPU/RSS measurements.
# Set BIT_DIRECTORY_TMPDIR to an external disk directory for storage variation.
node scripts/rust-object-import/reader-import-qualification.cjs \
  /tmp/traversal-cli "$PWD/native/target/release/bit-object-import"
```
