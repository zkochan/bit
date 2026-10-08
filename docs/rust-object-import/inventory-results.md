# Batched object-store existence checks

Measured on Linux x64, Node 24.21.0 with a release helper. Nine interleaved rounds after excluded warm-up, half existing/half missing object paths, using the actual current `Repository.hasMultiple()` implementation. Each result is compared with the expected ordered Ref list. Timed batches include helper startup/exit and all batch splitting; Node/compiler/model-loader startup is outside these timings. Callback counts come from separate async resource diagnostics.

| Filesystem | Hashes | Node ms | Rust ms | Reduction | Node filesystem requests |
| ---------- | -----: | ------: | ------: | --------: | -----------------------: |
| tmpfs      |  1,024 |    2.72 |    2.13 |     21.6% |                1,024 → 0 |
| tmpfs      |  4,096 |   10.91 |    3.33 |     69.5% |                4,096 → 0 |
| tmpfs      | 16,384 |   38.93 |   13.58 |     65.1% |               16,384 → 0 |
| Btrfs      |  1,024 |    3.07 |    2.15 |     30.0% |                1,024 → 0 |
| Btrfs      |  4,096 |    9.14 |    3.00 |     67.2% |                4,096 → 0 |
| Btrfs      | 16,384 |   44.29 |   11.47 |     74.1% |               16,384 → 0 |

An initial 256-hash probe showed helper startup could cost more than Node checks. Production therefore uses Rust only for at least 1,024 hashes. Smaller batches retain Node. Existing-path checks include directories and follow symlinks; dangling links/inaccessible paths are absent, matching canonical path-existence semantics. No new inventory cache is introduced.

The compiled artifact-import API was qualified against a genuine file remote containing 2,048 Sources. Rust inventory returned 0 existing on cold import, 2,048 on repetition, and 2,047 after deletion. Cold import and subsequent repairs passed complete compressed-byte readback; a missing helper also repaired an absent object through canonical fallback. Duplicate request hashes were removed by the existing importer policy.

Genuine compiled `bit import --objects` smoke checks passed for file and loopback HTTP transports across all five comparison modes, including full Source/model/history/head/tag/index readback, repeated imports and missing/crashing-helper fallback. These small command fixtures check compatibility; their inventory groups stay below the new threshold. They do not establish a whole-command inventory speedup. The artifact API qualification above explicitly verifies that large inventory groups execute in Rust.

Validation: 48 Node tests, 38 Rust workspace tests, strict inventory TypeScript, canonical `npm run lint` in the isolated rebuilt CLI, and the inherited pnpm Rust formatter/Clippy/perfectionist checks pass without new exceptions. The private bootstrap compiled all 334 components with zero errors, then rebuilt the three affected import components. Cross-platform CI covers protocol transport; production Windows inventory remains on Node.

Raw JSON/logs/fixtures remain outside Git on the development machine (`inventory-tmpfs.json`, `inventory-btrfs.json`, `inventory-command-smoke.json`, `inventory-http-smoke.json`). Only compact results and reproduction drivers are committed.

```sh
BIT_LEGACY_ROOT=/tmp/prepared-bit-cli \
  BIT_INVENTORY_REPORT="$HOME/bit-inventory-evidence.json" \
  node scripts/rust-object-import/inventory-benchmark.cjs
# Set BIT_INVENTORY_TMPDIR to an external directory for disk variation.
node scripts/rust-object-import/inventory-import-qualification.cjs \
  /tmp/object-import-cli "$PWD/native/target/release/bit-object-import"
```
