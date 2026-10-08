# Object-import processing in Rust

Umbrella: [#33](https://github.com/zkochan/bit/issues/33). Base branch: `rust-object-import`, forked from `rust` at `46c22f4264b0946402d51d8393c80db68530294d`. This work does not change `rust` or the upstream dependency-scanning PR.

## Where time is spent

`ScopeComponentsImporter` checks local/missing objects and requests remote objects. `ObjectFetcher` fetches remote streams concurrently and sends each into `ObjectsWritable`; each stream awaits its write before accepting the next object. `ObjectsWritable` inflates and parses every object, collects mutable components for merging, merges versions/histories, and sends immutable objects to `WriteObjectsQueue`. The queue previously deduplicated with a growing array. Source writes previously serialized and compressed content again, despite receiving the compressed representation over the network.

The repository already provides compressed-buffer reuse, atomic temporary-file/rename writes, ownership/permission handling, persist hooks, cache layers and index updates. Native Source persistence implements their atomic write and metadata behavior in Rust when no content transformers are registered; other objects use the existing facilities. It does not replace network/authentication, component/lane/version merge policy or index construction. Network latency remains outside the native work.

## Four comparable paths

- Default: existing parsing and persistence, with Set-based ordered queue deduplication.
- JavaScript control: parse/hydrate Sources, verify content identity, and reuse their received compressed buffers. This isolates savings available without Rust.
- Validation only: a persistent per-import helper streams decompression and SHA-1 validation of immutable Sources. Node receives identity/size results and uses its existing atomic writer and persist hook.
- Native persistence: the helper validates a batch; JavaScript reserves the eligible Source hashes in import order; Rust writes the selected compressed buffers in parallel with temporary-file/rename atomicity and ownership/permission handling. Two responses cover a batch of up to 16 objects. Successful acknowledgements invalidate both JavaScript cache layers synchronously, without a filesystem Promise per Source. Unknown/mutable objects use the canonical parser/merger. Failed native writes are retried through the existing JavaScript writer.

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

Native persistence uses the same record framing with `BOI2`. After complete validation, JavaScript sends `BOC2`, the request ID, count and selected u32 indices. Rust checks every selection before writing anything, then acknowledges disjoint `persisted`/`failed` indices covering the entire selection. No Source bytes cross back into JavaScript. The two-phase selection preserves queue deduplication across native Sources and legacy objects, and commits an already accepted prefix before propagating a later canonical parsing error. Native per-hash state is cleared after each commit, bounding it to the current batch.

Limits: 16 objects/128 MiB compressed per batch, 64 objects/256 MiB compressed outstanding in the coordinator, 1 GiB inflated per object, 256-byte Source header, 16 KiB response, 120-second batch timeout. Native decompression uses a reusable 64 KiB chunk per worker; the helper defaults to at most four workers. Input/output backpressure, protocol/crash/timeout fallback and bounded termination are tested. These are processing limits; existing upstream remote-stream buffers remain outside them. Exceeding eligibility limits uses the legacy path.

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

The measured command results are in [command-results.md](./command-results.md), and the broader native migration stages are in [next-native-stages.md](./next-native-stages.md).
