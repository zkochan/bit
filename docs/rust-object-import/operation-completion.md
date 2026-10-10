# Operation-level object import completion

This change completes the remaining implementation and qualification work in [#33](https://github.com/zkochan/bit/issues/33), following merged [PR #69](https://github.com/zkochan/bit/pull/69). It consolidates merge kernels, component/index work, transfer coordination, cancellation, trusted provisioning and complete command qualification in one PR.

## Behavior and compatibility

An eligible import owns a bounded, persistent Rust operation session. `BOP1` groups up to 64 already-ready operations without a batching delay; each frame is limited to 8 MiB and responses to 32 MiB. The queue allows at most 64 requests and 32 MiB of queued data. Unsupported projections, custom methods/hooks, stale plans and helper failure retain canonical JavaScript behavior. Timeout and malformed-response fallback waits for helper termination before any retry that could race a native write.

Native Version decisions compare the canonical date strings in UTF-16 order. VersionHistory respects original hash-map keys when shared Refs change; LaneHistory preserves incoming overlay order and optional fields. Component plans preserve origin/cache policy, local-version conflicts, orphaned tags and detached heads. JavaScript applies plans to existing instances and produces canonical public errors. Application rechecks the live projection synchronously, including when multiple remote replies coalesce in one frame. Canonical parsing, schema validation, dependency/extension construction and serialization remain authoritative.

Index plans preserve category collisions, duplicate hashes, lane renames and append order. Linux index commits use exact canonical JSON and atomic replacement with owner, mode, bounded xattrs and access ACL preservation; unsupported links or metadata select canonical writes. macOS and Windows retain canonical index writes. Model compression/persistence uses canonically serialized small payloads. Larger payloads retain Node after earlier measured crossover results.

`BMS1` batches one remote's accepted sequential Version prefix, with at most 16 objects of at most 16 KiB each. It reads the complete frame before writing and stops at the first write failure. Node retries in original order. Batches flush before Source selection, other model policies and invalid input, preserving partial-prefix behavior. Independent remote requests retain the existing `BMP1` grouping semantics.

`BSP1` appends at most 1 MiB per request to the owned archive with exact offset acknowledgements. Existing limits remain four active/16 waiting transfers and 2 GiB per archive. If a helper exits after an unacknowledged append, replay verifies the actual prefix bytes before continuing. Invalid prefix state rejects rather than duplicating or dropping bytes. Native tar traversal, start/end/error envelopes, progressive batches and canonical suffix repair remain in force.

An optional ObjectFetcher AbortSignal cancels remote resolution, HTTP requests, retry waits, streams, staging and helper sessions. Caller cancellation reasons survive remote-error attribution. Helper disposal is awaited. Tests cover cancellation before headers and during active intake, incomplete responses and both origin/cache arrival orders.

Missing lookup reuse keeps at most 1,024 hashes within the import operation. Own writes invalidate it; external create/delete and permission changes are checked through fresh native metadata before a missing read can be skipped. Throwing loads retain canonical error construction. No missing result survives the operation.

## Distribution and platform policy

Release assembly automatically obtains a source/revision/target-bound helper from a successful same-repository GitHub Actions push or dispatch on the trusted Rust branches. Provisioning validates the exact workflow, repository, revision, artifact digest, size, archive members, executable ABI, notices and native source identity before immutable installation. GitHub credentials remain on the API host and never follow signed redirects. Runtime discovery never downloads. An explicit artifact still works for offline release assembly. `BIT_RUST_OBJECT_IMPORT_PROVISION=off` opts release assembly out; failures otherwise reject assembly rather than silently install an untrusted binary.

Linux qualification includes default/access ACLs, xattrs, read-only files, symlinks and hardlinks. Canonical-model CI builds the actual Bit graph on Linux, macOS and Windows; Windows qualification compares creation/replacement ACLs and read-only success/error behavior against Node. Portable protocol, inventory/header/read/traversal and packaged artifact CI continues across the supported OS/architecture matrix. Native Windows writes require `BIT_RUST_OBJECT_IMPORT_WINDOWS_WRITES=on`; unsupported metadata stays on Node.

## Qualification and rollout

Complete cold and repeated HTTP imports are compared with the merged PR #69 CLI/helper, using separate immutable physical CLI graphs. Retained rounds alternate modes after an excluded warm-up. Object-only workloads cover many small files, compressible and binary large files, mutable-heavy data, multiple and concurrent remotes, seeded origin/local overlap and short/long retained histories on tmpfs and Btrfs. Checkout and dependency-install commands also verify workspace file bytes, bitmap entries and installed package/source links. Separate diagnostics verify actual native execution and full repository Source/model/Version/tag/head/history/index readback. CPU includes the client and all helper children; simultaneous RSS is sampled. Loopback server resources are excluded.

Results and reproduction commands are recorded below. Controlled authenticated HTTP delay and cancellation tests qualify transport behavior; these are not deployment WAN latency measurements.

The rollout decision is to retain opt-in activation. The change implements the operation boundary and supports workload-specific qualification, but does not justify broad default activation or a network-latency claim. Canonical component hydration and larger streaming object reads remain as qualified previously; replacing them without complete-command evidence would violate the rollout criterion.

To select the candidate operation boundary, set the existing helper selector and `BIT_RUST_OBJECT_TAR=on`, then `BIT_RUST_OBJECT_IMPORT_OPERATION=on`. Sequential batches and missing reuse additionally require `BIT_RUST_OBJECT_IMPORT_SEQUENTIAL=on` and `BIT_RUST_OBJECT_IMPORT_MISSING=on`. All changes preserve the existing default selections.

## Retained results (2026-10-11)

Linux x64, Node 24.21.0, GNU time, 10 ms process-tree RSS samples, tmpfs and Btrfs. The baseline is merged PR #69; the candidate uses the final compiled graph. Nine retained alternating rounds per mode follow excluded warm-up for the rows below. These are complete client commands, including helper startup and shutdown; fixture generation, readback, diagnostics and CPU profiles are excluded from timing.

| Command/workload                                          | Filesystem | Cold wall ms, baseline → candidate | Cold CPU s, baseline → candidate | Cold sampled RSS MiB, baseline → candidate | Repeated wall ms, baseline → candidate |
| --------------------------------------------------------- | ---------- | ---------------------------------: | -------------------------------: | -----------------------------------------: | -------------------------------------: |
| Objects, 400 components / four remotes / eight Versions   | tmpfs      |                      585.2 → 550.0 |                      0.93 → 0.88 |                              223.8 → 221.5 |                          382.8 → 391.6 |
| Same concurrent import                                    | Btrfs      |                      637.9 → 621.5 |                      1.04 → 1.01 |                              226.6 → 222.3 |                          389.2 → 399.2 |
| Full checkout, 16 components / two remotes                | tmpfs      |                      313.3 → 323.8 |                      0.42 → 0.43 |                              159.5 → 164.0 |                          291.7 → 301.1 |
| Same checkout                                             | Btrfs      |                      314.1 → 344.6 |                      0.43 → 0.45 |                              160.2 → 163.6 |                          300.6 → 300.9 |
| Full dependency installation, same workspace              | tmpfs      |                    1482.3 → 1485.2 |                      1.44 → 1.44 |                              412.3 → 410.3 |                        1124.3 → 1124.1 |
| Same installation                                         | Btrfs      |                    1574.5 → 1595.8 |                      1.48 → 1.49 |                              424.8 → 423.4 |                        1182.0 → 1189.8 |
| Concurrent objects, controlled 100 ms HTTP response delay | tmpfs      |                      695.2 → 656.9 |                      0.95 → 0.90 |                              225.8 → 221.8 |                          484.2 → 503.6 |

The concurrent tmpfs cold wall reduction is 6.0%, with nonoverlapping observed ranges of 574.0–604.1 versus 542.0–569.4 ms. CPU ranges overlap (0.91–0.96 versus 0.87–0.92 seconds). Btrfs cold wall ranges overlap (618.4–656.0 versus 613.5–647.4 ms), as do CPU ranges (1.01–1.08 versus 0.99–1.05 seconds). RSS ranges overlap on both filesystems; there is no reliable memory-saving claim. Repeated commands generally regress, checkout regresses, and installation differences are within overlapping observed ranges. The controlled delay is identical in both modes and does not establish any reduction in network latency or deployment WAN performance.

Ten additional cold/warm workload checks use three retained alternating rounds per mode on each filesystem. These short runs qualify readback and compatibility, rather than establish broad performance gains:

| Object-only workload                                      | tmpfs cold wall ms, baseline → candidate | Btrfs cold wall ms, baseline → candidate |
| --------------------------------------------------------- | ---------------------------------------: | ---------------------------------------: |
| Many small files                                          |                            392.8 → 395.4 |                            433.5 → 443.8 |
| Large compressible files                                  |                            340.8 → 344.7 |                            337.7 → 354.3 |
| Large binary files                                        |                            343.5 → 353.1 |                            347.4 → 365.9 |
| Mutable-heavy                                             |                            733.0 → 712.3 |                            808.1 → 808.6 |
| Concurrent mutable                                        |                            578.5 → 568.7 |                            653.4 → 625.6 |
| Multiple remotes with large files                         |                            307.5 → 319.6 |                            315.4 → 336.5 |
| Retained histories with 32 local + 32 incoming Versions   |                            292.7 → 290.1 |                            296.1 → 299.6 |
| Retained histories with 512 local + 512 incoming Versions |                            503.0 → 472.8 |                            534.5 → 530.8 |
| Seeded origin overlap                                     |                            445.7 → 449.9 |                            460.6 → 477.4 |
| Seeded local overlap                                      |                            451.0 → 453.0 |                            473.7 → 480.7 |

Diagnostics distinguish the 64-request model-write backpressure fallback from helper failure. Large component/history payloads remain canonical above the 16 KiB cutoff. Native archive transfer, eligible model persistence, component/history plans and index planning are verified; no unexpected operation/Source fallback occurs. Canonical Version parsing, serialization and round-trip validation remain active. Every timed command verifies Source bytes, model data, Versions, tags, heads, histories and indexes. Full workspace commands verify 32 source files; installation also verifies all 16 component package names/versions and source symlinks.

Separate cold/warm CPU profiles cover concurrent mutable imports and long retained histories. They show module loading, garbage collection, process startup and canonical model work; they do not supply evidence to replace canonical component hydration or expand streamed reads. Existing native traversal, bounded classification/reads and Source hashing stay as previously qualified. The measured checkout and repeated-command costs support retaining the opt-in rollout decision.

Validation: 261 applicable Node tests pass with two platform-specific skips; 69 unchanged canonical model/index specifications pass against the physical compiled graph. All 60 Rust tests, inherited pinned formatting, warning-denied Clippy, perfectionist Dylint, rustdoc, canonical TypeScript and Oxlint pass. Linux/macOS/Windows canonical-model and real metadata/ACL jobs pass, including Windows explicit ACL replacement and read-only behavior. All 20 runnable implementation CI checks pass. No lint exceptions or generated evidence are committed.

Raw reports, excluded exploratory runs, CPU profiles, archives and logs remain outside Git under `$HOME/bit-object-completion-evidence-2026-10-10`. `final-provenance-audit.json` verifies all ten final reports against the final helper, actual compiled modules and harness. Baseline/candidate helper SHA-256 values are `a80ddacc6dcb1a1592736871b2d13bdb71b38236d3aa55c680647ef86b4acdeb` and `43c9ff81a1ae8af91884ae12a54f4592c884115579c0b58f97b92119f90c72b9`.

Reproduction uses the actual isolated CLI graphs produced by `prepare-cli.cjs`, with the baseline extracted from the merged #69 artifact. For the concurrent comparison:

```sh
BIT_IMPORT_QUALIFICATION_BASELINE_CLI=/path/to/merged-cli \
BIT_IMPORT_QUALIFICATION_BASELINE_HELPER=/path/to/merged-helper \
BIT_IMPORT_QUALIFICATION_MODES=tar-baseline,tar-operation \
BIT_IMPORT_QUALIFICATION_TRANSPORT=http \
BIT_IMPORT_QUALIFICATION_ROUNDS=9 \
BIT_IMPORT_QUALIFICATION_CASES=concurrent-mutable \
BIT_IMPORT_QUALIFICATION_TMPDIR=/external/scratch \
BIT_IMPORT_QUALIFICATION_REPORT=/external/results.json \
node --expose-gc scripts/rust-object-import/import-qualification.cjs \
  /path/to/candidate-cli /path/to/candidate-helper
```

Use `BIT_IMPORT_QUALIFICATION_COMMAND=checkout` or `install` with case `command-workspace` for full workspace commands. Set `BIT_IMPORT_QUALIFICATION_HTTP_DELAY_MS=100` for the controlled delay and `BIT_IMPORT_QUALIFICATION_CPU_PROFILE_DIR` to an external directory for separate profiles. Full reproduction settings are retained in `qualify-remaining.cjs` alongside the evidence.
