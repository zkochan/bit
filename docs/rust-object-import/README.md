# Object-import processing in Rust

Umbrella: [#33](https://github.com/zkochan/bit/issues/33). Base branch: `rust-object-import`, forked from `rust` at `46c22f4264b0946402d51d8393c80db68530294d`. This work does not change `rust` or the upstream dependency-scanning PR.

## Where time is spent

`ScopeComponentsImporter` checks local/missing objects and requests remote objects. `ObjectFetcher` fetches remote streams concurrently and sends each into `ObjectsWritable`; each stream awaits its write before accepting the next object. `ObjectsWritable` inflates and parses every object, collects mutable components for merging, merges versions/histories, and sends immutable objects to `WriteObjectsQueue`. The queue previously deduplicated with a growing array. Source writes previously serialized and compressed content again, despite receiving the compressed representation over the network.

The repository already provides compressed-buffer reuse, atomic temporary-file/rename writes, ownership/permission handling, persist hooks, cache layers and index updates. Native Source persistence implements their atomic write and metadata behavior in Rust when no content transformers are registered. Small Version/VersionHistory/LaneHistory writes also use native compression/persistence after canonical Node merge decisions. Network/authentication, merge policy and index construction remain in Node. Network latency remains outside the native work.

## Comparable paths

- Default: existing parsing and persistence, with Set-based ordered queue deduplication.
- JavaScript control: parse/hydrate Sources, verify content identity, and reuse their received compressed buffers. This isolates savings available without Rust.
- Validation only: a persistent per-import helper streams decompression and SHA-1 validation of immutable Sources. Node receives identity/size results and uses its existing atomic writer and persist hook.
- Source-only native persistence (`BIT_RUST_OBJECT_IMPORT_METADATA=off`, `BIT_RUST_OBJECT_IMPORT_MUTABLE=off`): the helper validates a batch; JavaScript reserves the eligible Source hashes in import order; Rust writes the selected compressed buffers in parallel with temporary-file/rename atomicity and ownership/permission handling. Two responses cover a batch of up to 16 objects. Successful acknowledgements invalidate both JavaScript cache layers synchronously, without a filesystem Promise per Source. Unknown/mutable objects use the canonical parser/merger. Failed native writes are retried through the existing JavaScript writer.

- Source + metadata (`BIT_RUST_OBJECT_IMPORT_MUTABLE=off`): adds bounded parallel metadata inflation in Rust. Node receives lossless UTF-8 metadata and uses the existing model parser, merges and persistence. Invalid or oversized metadata falls back to Node inflation.
- Source + metadata + mutable persistence (the native default): Node applies canonical Version/history merge decisions and serialization; a second persistent helper compresses and atomically writes eligible metadata, returning one acknowledgement per write. Cache/live-object updates retain the hydrated instance. Serialized metadata above 16 KiB retains Node compression/persistence; this cutoff follows the measured crossover. Disable this stage independently with `BIT_RUST_OBJECT_IMPORT_MUTABLE=off`.

Native persistence is enabled on Linux and macOS when the repository has no instance content overrides or registered read/persist transformers. The scope aspect installs hooks even for empty slots, so live slot checks distinguish an empty hook from an active transformer. Windows and active transforms retain native validation with Node persistence. Mutable-object merges, deduplication, indexes and post-persist notifications keep their existing JavaScript semantics. This is an opt-in implementation, not default enablement.

Source content supports empty/text/Unicode/binary bytes. Source header lengths use JavaScript string units, so native validation does not compare this field to byte length. It verifies header identity, SHA-1 content identity, complete zlib termination/checksum and absence of trailing data. Any unsupported/malformed native input requests legacy processing, preserving legacy error classes/messages and accepted representations.

## Build, opt in and roll back

Use a bootstrapped checkout of this feature branch/base with the integration applied. Building the helper alone does not enable it in an unrelated globally installed Bit CLI.

```sh
cd native
cargo build --locked --release -p bit-object-import
cd ..

BIT_RUST_OBJECT_IMPORT="$PWD/native/target/release/bit-object-import" bit import <component-id>
BIT_RUST_OBJECT_IMPORT_MODE=validate \
  BIT_RUST_OBJECT_IMPORT="$PWD/native/target/release/bit-object-import" bit import <component-id>
BIT_RUST_OBJECT_IMPORT=control bit import <component-id>
BIT_RUST_OBJECT_IMPORT=off bit import <component-id>
```

The executable override must be an absolute path; use `.exe` on Windows. Unset the variable to restore the default path. It is independent of `BIT_RUST_DEPENDENCY_SCANNER`. There is no packaged discovery/installer for this prototype yet. Rust uses the existing workspace's exact inherited pnpm formatter, Clippy and perfectionist configurations; no lint exceptions were added.

## Protocol and limits

Validation-only input is a binary frame: `BOI1`, big-endian u32 request ID/count, then records of 20-byte SHA-1, big-endian u32 compressed length, and compressed bytes. Output is one versioned JSON line of ordered `source`/`legacy` results, identities and sizes. Node validates the complete response before allowing any native result to be persisted. Payloads are not base64 encoded.

Native persistence uses the same record framing with `BOI3` (or `BOI2` with metadata disabled). After complete validation, JavaScript sends the matching `BOC3`/`BOC2`, the request ID, count and selected u32 indices. Rust checks every selection before writing anything, then acknowledges disjoint `persisted`/`failed` indices covering the entire selection. No inflated Source bytes cross back into JavaScript during native persistence. The two-phase selection preserves queue deduplication across native Sources and legacy objects, and commits an already accepted prefix before propagating a later canonical parsing error. Native per-hash state is cleared after each commit, bounding it to the current batch.

Limits: 16 objects/128 MiB compressed per batch, 64 objects/256 MiB compressed outstanding in the coordinator, 1 GiB inflated per object, 256-byte Source header, 256 KiB inflated metadata per object, 32 MiB response, 120-second batch timeout. Native decompression uses a reusable 64 KiB chunk per worker; the helper defaults to at most four workers. Input/output backpressure, protocol/crash/timeout fallback and bounded termination are tested. These are processing limits; existing upstream remote-stream buffers remain outside them. Exceeding eligibility limits uses the legacy path.

Mutable persistence uses `BMP1`, big-endian u32 ID/count, then 20-byte identities and u32 serialized lengths followed by canonical serialized bytes. The helper accepts only matching Version/VersionHistory/LaneHistory headers, at most 16 objects and 512 KiB per object (8 MiB per frame); duplicate identities and truncated frames fail before any writes. The coordinator caps outstanding records at 64 (32 MiB), while production selects serialized inputs at most 16 KiB. Ordered response `sizes` contain compressed lengths or `null` for canonical retry. A failed/timed-out session must exit before retrying mutable writes, preventing a late native rename from overwriting the retry. The mutable session is separate because the Source session waits for an ordered commit while Node makes merge decisions. Fusing these operation boundaries remains future work. Qualification: [mutable-results.md](./mutable-results.md).

## Reproduce validation and measurements

The standalone test loader uses TypeScript and the bootstrapped Bit package graph. `BIT_LEGACY_ROOT` can point to a separate prepared Bit checkout; by default it uses this checkout. Persistence tests load the current stream/queue/validator and new repository method, retaining the supplied graph's model identities and existing repository implementation. The fetcher test exercises the actual ObjectFetcher against two in-memory remote streams, not a real network server.

```sh
(cd native && cargo test --locked --workspace)
BIT_TEST_OBJECT_IMPORT="$PWD/native/target/release/bit-object-import" \
  node --test scripts/rust-object-import/*.test.cjs

# Linux, GNU time and /proc; fixtures/results go to the OS temporary directory.
BIT_TEST_OBJECT_IMPORT="$PWD/native/target/release/bit-object-import" \
  node scripts/rust-object-import/benchmark.cjs
```

The benchmark uses fresh processes and fresh destination repositories, an excluded warm-up, nine interleaved rounds per mode, identical fixture bytes across modes, complete content/hash readback, startup-inclusive wall time, GNU time total child CPU and 10 ms sampled process-tree RSS including the helper. The writer-only memory snapshot includes startup and stops at the persistence completion event. The subsequent-read cost is reported separately. These are local Source-stream/repository measurements, not full `bit import` command or server/network benchmarks. Destinations currently use the machine's OS temporary-directory filesystem.

Only compact Markdown and drivers belong in Git. Generated fixtures, raw JSON/logs and profiles stay outside the source repository.

Measured local results and limits: [local-results.md](./local-results.md). CI runs the native workspace on Linux x64/ARM64, macOS Intel/ARM64 and Windows; coordinator type/protocol tests run on Linux/macOS/Windows. Real repository/fetcher tests require a bootstrapped Bit graph and are currently locally verified, not part of the isolated-compiler CI job.

## Real-command qualification

The qualification harness builds genuine bare remote scopes with Sources, Versions, component heads/tags, parent histories and indexes. It runs the compiled `bit import --objects` command in fresh standalone workspaces, then independently checks every stored Source and model, both after the cold all-history import and a normal repeated import. File remotes and loopback HTTP remotes are supported. The HTTP fixture uses Bit's compiled FetchRoute and actual tar encoder/decoder; authentication and WAN latency are outside that fixture. Remote-server CPU/memory is outside the client measurements.

To prepare an isolated CLI, supply a privately bootstrapped Bit checkout carrying `.bit-rust-private-build.json` provenance. The driver copies it physically, reroutes package aliases into the copy, copies the affected sources, and uses Bit's normal compiler. It records source and compiled hashes, and never overwrites the supplied original or globally installed CLI.

```sh
node scripts/rust-object-import/prepare-cli.cjs /tmp/prepared-bit-cli /tmp/object-import-cli
BIT_IMPORT_QUALIFICATION_REPORT="$HOME/bit-import-evidence.json" \
  node --expose-gc scripts/rust-object-import/import-qualification.cjs \
  /tmp/object-import-cli "$PWD/native/target/release/bit-object-import"
# Repeat with BIT_IMPORT_QUALIFICATION_TRANSPORT=http for loopback HTTP/tar imports.
```

The default is nine interleaved rounds per mode after excluded warm-up, across many-small, large-compressible, large-binary, mutable-heavy and multi-remote workloads. `BIT_IMPORT_QUALIFICATION_SMOKE=1` adds missing/crashing-helper command checks with small fixtures; `BIT_IMPORT_QUALIFICATION_CASES` selects comma-separated workloads. `BIT_IMPORT_QUALIFICATION_TMPDIR` selects an external scratch directory for storage variation; its filesystem type is recorded in the report. Raw reports are saved after each completed workload outside the repository. Parent readback clears its private scope caches and optional exposed GC runs between commands; timed CLI processes retain normal production caching and GC.

Separate diagnostic runs record stages and async resource/callback counts. Inclusive asynchronous stage sums overlap and are not an elapsed-time decomposition. Diagnostic Promise counts include wrapper overhead and must not be treated as uninstrumented production totals. Untraced runs supply wall time, CPU and helper-inclusive RSS. No generated JSON, logs or large fixtures are committed.

The additional metadata results are in [metadata-results.md](./metadata-results.md). The measured Source command results are in [command-results.md](./command-results.md), and the broader native migration stages are in [next-native-stages.md](./next-native-stages.md).

## Batched inventory checks

With the native helper selected, `Repository.hasMultiple()` checks batches of at least 1,024 full lowercase SHA-1 hashes through the read-only `BEX1` protocol. Artifact imports and missing-history checks now use this batch API. Smaller batches, short/noncanonical refs, custom scalar/path overrides and Windows retain Node checks. `BIT_RUST_OBJECT_INVENTORY=off` disables this stage independently.

Each request holds at most 4,096 binary hashes, and concurrent callers share one helper slot. An operation groups up to four 4,096-hash frames (16,384 hashes) in one process; it retains no filesystem cache. Responses must contain the matching version/request identity and one boolean per input. Protocol errors, timeout, crash or an older helper cause the entire operation to use canonical Node checks. The filesystem existence contract remains disk-only: pending model objects do not make an absent path exist. Duplicates retain their original Ref instances and order.

See [inventory-results.md](./inventory-results.md) for measured batch latency, callback counts and actual artifact-import qualification. These are existence-check gains; they do not establish a whole-command speedup.

## Batched reads and header classification

With the helper selected, `loadManyRaw()` and `loadManyRawIgnoreMissing()` use bounded binary compressed-buffer reads for at least 1,024 full hashes when no content transformers or custom read/path overrides are active. `BRD1` groups at most 4,096 hashes per process, split into 128-object frames inside that process. Each native file is limited to 256 KiB compressed and the combined response to 32 MiB plus framing allowance. Oversized/unreadable individual files use scalar Node reads; oversized or invalid responses discard the complete native operation and fall back. Returned buffers preserve bytes, order, deduplication policy and original Ref identities. Ignore-missing still suppresses only canonical `ENOENT`; other errors propagate.

`listObjectsWithType()` uses `BHD1` for at least 256 hashes, returning type, compressed size and modification time for up to 4,096 objects per frame and 16,384 objects per process. Rust reads and drains only the first 512 compressed bytes, retains at most a 256-byte header and uses 64 KiB inflate chunks. It checks the entire prefix for errors even after finding the header. Node retains registered-type policy, unreadable reporting and fallback. Classification does not promise full-file integrity or an atomic filesystem snapshot. Stores with all 256 canonical hash-prefix directories can combine traversal and classification in Rust as described below.

Both stages share the bounded read-only helper slot with existence checks. They retain no object-store cache or completed response in that slot. `BIT_RUST_OBJECT_READS=off` and `BIT_RUST_OBJECT_HEADERS=off` disable them independently. Windows, small batches, short/noncanonical hashes and active/custom transformations remain on Node. Large compressed Source buffers exceeding transfer eligibility also remain on Node.

Qualification and reproducible measurements: [read-results.md](./read-results.md). These API-stage latency gains do not establish a whole-command import speedup.

## Directory traversal and combined inventories

With the helper selected, `listRefs()` uses `BWR1` for stores with all 256 lowercase hash-prefix directories. `listObjectsWithType()` combines traversal and compressed-header classification in one `BWD1` process when its inventory/read/path methods and transforms retain the canonical behavior. Smaller layouts retain Node glob traversal. `BIT_RUST_OBJECT_TRAVERSAL=off` independently restores Node traversal; `BIT_RUST_OBJECT_HEADERS=off` keeps classification on Node while reference traversal can still run in Rust.

Node checks the root layout with one directory read. Rust verifies that prefix snapshot and streams descending hashes in frames of at most 4,096 entries, combining prefixes within each frame. Hidden paths and visible root files are excluded, matching the existing two-level glob. Canonical leaf directories and symlinks remain inventory entries; unreadable headers use the existing scalar classification and reporting. Uppercase hashes, unusual prefix/leaf paths, symlinked prefixes and inaccessible/changed layouts request whole-operation fallback, preserving canonical validation and logging. Global glob order was already unstable between calls; callers receive the same hash set, with a deterministic descending order on the native path.

Requests and results are bounded to 256 prefixes, 65,536 entries per prefix, 1,048,576 objects per operation and 4 MiB per response line. Frames require matching identity, sequence, mode and strictly descending unique hashes; a final completion frame and successful helper exit are mandatory. Partial results, malformed/trailing output, timeout and helper failure are discarded. Helpers share the existing read-only slot, are terminated on failure, and release the slot only after exit. No filesystem cache or atomic-snapshot guarantee is introduced.

See [traversal-results.md](./traversal-results.md) for complete inventory timings, filesystem callbacks, whole-client CPU and sampled process-tree memory, genuine-scope qualification and reproduction commands. These are inventory-stage measurements, including the garbage collector's classification API; they do not establish a whole-command import speedup.

## Grouped read-only operations

Explicit-hash existence and header requests group up to four 4,096-hash frames per helper invocation. Frames retain independent sequential request identities; the complete operation is discarded on a missing/extra/reordered/corrupt frame, nonzero exit, timeout or response-size violation. Header output remains capped at 8 MiB, while existence output is bounded to six bytes per hash plus 1 KiB of framing. Concurrent operations still share one read-only helper slot. Raw compressed-buffer reads keep their existing 4,096-hash/32-MiB grouping, and directory traversal keeps its own streaming protocol.

`BIT_RUST_OBJECT_READ_OPERATIONS=off` restores one existence/header frame per helper independently of the other native stages. Helpers exit after each operation and retain no filesystem cache. Existing object/cache/Ref policy stays in Node. See [read-operation-results.md](./read-operation-results.md) for actual compiled API measurements and genuine 16,384-Source import qualification. These are bounded read-only stage gains rather than complete import-command improvements.

Standalone release artifact builds and qualification are documented in [standalone-artifacts.md](./standalone-artifacts.md). Explicit installation, runtime binding, `BIT_RUST_OBJECT_IMPORT=packaged`, and rollback are documented in [packaged-helper.md](./packaged-helper.md). Normal releases do not yet automatically include the helper.

Read-size budgeting and the rejected streaming experiment: [read-budget-results.md](./read-budget-results.md).

Windows header classification and timestamp parity: [windows-headers.md](./windows-headers.md).

Windows directory traversal and combined inventories: [windows-traversal.md](./windows-traversal.md).

Tar intake compatibility and Source-only prototype measurements: [tar-intake-results.md](./tar-intake-results.md).

Experimental staged tar framing and selected Source persistence: [tar-batches.md](./tar-batches.md). This kernel is not yet connected to normal imports.

Owned archive staging, cancellation and staging-inclusive HTTP qualification: [tar-staging.md](./tar-staging.md).

Lossless pre-policy staging fallback and received-prefix error parity: [tar-prefix-replay.md](./tar-prefix-replay.md).

Actual repository writer coordination for staged batches: [tar-coordination.md](./tar-coordination.md).
