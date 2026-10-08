# Mutable object compression and persistence

The importer applies the existing Version, VersionHistory and LaneHistory merge policies in Node, serializes the resulting object canonically, and moves eligible compression/atomic persistence into a persistent Rust session. This removes per-object Node filesystem/compression callbacks. Cache updates preserve the hydrated instance and inflated-size accounting. Component/lane indexing remains canonical; these three metadata types are not indexed by ScopeIndex.

Native Version/history merge policy is still future work. VersionHistory merging now uses a Set for existing-only membership, retaining the original stored-key semantics, incoming-first order, duplicate resolution, parents/unrelated/squashed fields and local graph state. This makes the formerly quadratic filter linear without adding an IPC boundary for that decision.

## Complete commands

Linux x64, Node 24.21.0, release helper, nine interleaved rounds after excluded warm-up. Both modes use the current linear history merge, native Source persistence and native metadata inflation. `mutable-control` disables only the new mutable writer. Commands are actual compiled `bit import --objects --all-history`, including CLI/helper startup and exit. Cold destinations are fresh; every cold and repeated import passes full content/model/history/head/tag/index readback. The local file remote runs on tmpfs and Btrfs; these measurements do not cover WAN latency, dependency installation or checkout.

| Filesystem | Fixture       | Control ms | Native ms | Reduction | Control/native CPU seconds | Control/native sampled RSS MiB |
| ---------- | ------------- | ---------: | --------: | --------: | -------------------------: | -----------------------------: |
| tmpfs      | many-small    |     448.65 |    434.13 |      3.2% |                0.67 / 0.66 |                  184.9 / 183.0 |
| tmpfs      | mutable-heavy |   1,125.15 |  1,060.94 |      5.7% |                1.71 / 1.67 |                  297.1 / 297.1 |
| Btrfs      | many-small    |     469.64 |    444.38 |      5.4% |                0.75 / 0.73 |                  184.3 / 183.8 |
| Btrfs      | mutable-heavy |   1,175.69 |  1,110.98 |      5.5% |                1.81 / 1.81 |                  298.8 / 297.7 |

CPU includes child/helper CPU from GNU time; RSS is the median of each run's 10 ms sampled process-tree peak, including both helpers. Changes in CPU/RSS are small; these results do not establish a memory benefit. Repeated-command timing differences are small and inconsistent, and repeated commands do not exercise these mutable writes. No warm-command benefit is claimed.

Separate diagnostics confirm 300 native mutable writes for many-small and 3,600 for mutable-heavy, with zero write fallbacks. Mutable-heavy filesystem callbacks fall from about 60,795 to 42,342 (30.4%); zlib callbacks fall from 16,804 to 9,604 (42.8%). Promise callback changes are inconsistent because the faster writer changes Source batch formation. These are complete client callback counts, not elimination of all filesystem work. Larger shared operation boundaries remain worthwhile.

## Isolated processing stages and cutoff

Compiled writer-stage probes reuse a helper for 256 consecutive writes and include its startup/exit, canonical serialization and framing. Module loading, fixture preparation and verification reads are outside the timer. Every result passes cold readback. These probes do not measure isolated CPU/RSS.

| History entries per object | Node ms | Selected path ms | Node filesystem requests | Node compression handles |
| -------------------------: | ------: | ---------------: | -----------------------: | -----------------------: |
|                          8 |   20.04 |            12.88 |                1,792 → 0 |                  256 → 0 |
|                        128 |   31.26 |            24.93 |                1,792 → 0 |                  256 → 0 |
|                        512 |   64.63 |            65.89 |            1,792 → 1,792 |                256 → 256 |

The initial unrestricted writer regressed for larger histories. Production therefore selects serialized metadata at most 16 KiB. Larger objects retain Node compression/persistence and reuse their canonical serialization. The 512-entry probe verifies this fallback; it is not a native speedup. The protocol's independent 512 KiB per-record bound permits further batch experiments without widening production selection.

Separate incoming-half-overlap history merge probes compare the original algorithm with the current linear filter: 4,096 entries take 32.97 → 1.87 ms, and 16,384 take 113.90 → 9.45 ms. Both preserve the same ordered records. These are JavaScript algorithm improvements, independent of native persistence, and are not counted as Rust command gains.

## Compatibility and limits

- Canonical Version newer/older selection, VersionHistory parents/unrelated/squashed/order/local graph state, LaneHistory duplicate logs/deleted/updateDependents and local scope/name remain unchanged. Native merge policy is not implemented here.
- The compiled importer verifies native execution, hydrated cache identity, cold disk readback, newer-Version rejection, oversized metadata, missing helpers, content transformers, repository overrides, index overrides and canonical write-error kinds.
- `BMP1` input is bounded to 16 unique identities, 512 KiB serialized bytes each, 8 MiB per frame and 64 outstanding records/32 MiB in the coordinator. Production selects at most 16 KiB per object. Only matching Version/VersionHistory/LaneHistory headers are accepted. Serialized content comes from the canonical Node model serializer; the helper does not implement model validation or JSON merge policy.
- Acknowledgements return compressed lengths or per-record fallback. Truncated/oversized/duplicate frames fail before any writes. Mutable retries wait for a failed helper to exit, preventing a late native rename from racing canonical persistence. Repeated replacements clear per-batch store deduplication state.
- The mutable helper is a second lazy per-import session, shared across remotes. The Source session waits for a commit while Node makes merge decisions; combining both sessions requires a larger protocol/operation change. There is no process launch per metadata object.
- Active hooks, custom repository/index/compression methods and Windows retain Node writes. `BIT_RUST_OBJECT_IMPORT_MUTABLE=off` disables this stage independently. Selection remains under the overall opt-in helper flag.

Local checks pass: 62 Node protocol/repository/fetcher tests, all 95 compiled object-component unit tests (including explicit GC), three VersionHistory tests through the normal Bit runner, 38 Rust workspace tests, strict coordinator TypeScript, isolated canonical `npm run lint`, Prettier and the inherited pnpm formatter/Clippy/perfectionist configuration with no new lint exceptions. File and original loopback HTTP/tar command smoke checks also pass, including missing/crashing helpers.

The full normal Bit source-test runner reports two repository class-identity failures (index rebuilding and registered Component identity) and one GC skip. The same two failures were reproduced against merged PR #38 code in a separate private copy. The compiled suite resolves the production package graph consistently and passes all 95 tests with `--expose-gc`; no source-runner fix is included in this PR.

Raw reports/logs stay outside Git on the development machine: `mutable-tmpfs.json`, `mutable-btrfs.json`, `mutable-stages-tmpfs.json`, `mutable-command-smoke.json`, `mutable-http-smoke.json`. Only this compact report, test fixtures and drivers are committed.

```sh
node scripts/rust-object-import/mutable-import-qualification.cjs \
  /tmp/object-import-cli "$PWD/native/target/release/bit-object-import"
node --expose-gc scripts/rust-object-import/mutable-benchmark.cjs \
  /tmp/object-import-cli "$PWD/native/target/release/bit-object-import" "$HOME/bit-mutable-stages.json"
BIT_IMPORT_QUALIFICATION_MODES=mutable-control,native \
  BIT_IMPORT_QUALIFICATION_CASES=many-small,mutable-heavy \
  BIT_IMPORT_QUALIFICATION_ROUNDS=9 \
  BIT_IMPORT_QUALIFICATION_REPORT="$HOME/bit-mutable-commands.json" \
  node --expose-gc scripts/rust-object-import/import-qualification.cjs \
  /tmp/object-import-cli "$PWD/native/target/release/bit-object-import"
# Set BIT_IMPORT_QUALIFICATION_TMPDIR to an external directory for disk variation.
```
