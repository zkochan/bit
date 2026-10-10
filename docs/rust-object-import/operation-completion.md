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

Results and reproduction commands are recorded below after final qualification. Controlled authenticated HTTP delay and cancellation tests qualify transport behavior; these are not deployment WAN latency measurements.

The rollout decision is to retain opt-in activation. The change implements the operation boundary and supports workload-specific qualification, but does not justify broad default activation or a network-latency claim. Canonical component hydration and larger streaming object reads remain as qualified previously; replacing them without complete-command evidence would violate the rollout criterion.

To select the candidate operation boundary, set the existing helper selector and `BIT_RUST_OBJECT_TAR=on`, then `BIT_RUST_OBJECT_IMPORT_OPERATION=on`. Sequential batches and missing reuse additionally require `BIT_RUST_OBJECT_IMPORT_SEQUENTIAL=on` and `BIT_RUST_OBJECT_IMPORT_MISSING=on`. All changes preserve the existing default selections.
