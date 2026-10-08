# Object-import Rust prototype

Umbrella: [#33](https://github.com/zkochan/bit/issues/33). Base branch: `rust-object-import`, forked from `rust` at `46c22f4264b0946402d51d8393c80db68530294d`. This work does not change `rust` or the upstream dependency-scanning PR.

## Where time is spent

`ScopeComponentsImporter` checks local/missing objects and requests remote objects. `ObjectFetcher` fetches remote streams concurrently and sends each into `ObjectsWritable`; each stream awaits its write before accepting the next object. `ObjectsWritable` inflates and parses every object, collects mutable components for merging, merges versions/histories, and sends immutable objects to `WriteObjectsQueue`. The queue previously deduplicated with a growing array. Source writes previously serialized and compressed content again, despite receiving the compressed representation over the network.

The repository already provides compressed-buffer reuse, atomic temporary-file/rename writes, ownership/permission handling, persist hooks, cache layers and index updates. The prototype uses these facilities. It does not replace network/authentication, component/lane/version merge policy or index construction. Network latency remains outside the native work.

## Three comparable paths

- Default: existing parsing and persistence, with Set-based ordered queue deduplication.
- JavaScript control: parse/hydrate Sources, verify content identity, and reuse their received compressed buffers. This isolates savings available without Rust.
- Native: a persistent per-import helper streams decompression and SHA-1 validation of immutable Sources. Node retains the compressed input and receives only validated identity/size results, then calls the existing atomic writer and persist hook. Other objects and helper failures use the legacy parser/merger. A successful write invalidates both cache layers; subsequent reads rehydrate the Source.

Source content supports empty/text/Unicode/binary bytes. Source header lengths use JavaScript string units, so native validation does not compare this field to byte length. It verifies header identity, SHA-1 content identity, complete zlib termination/checksum and absence of trailing data. Any unsupported/malformed native input requests legacy processing, preserving legacy error classes/messages and accepted representations.

## Build, opt in and roll back

Use a bootstrapped checkout of this feature branch/base with the integration applied. Building the helper alone does not enable it in an unrelated globally installed Bit CLI.

```sh
cd native
cargo build --locked --release -p bit-object-import
cd ..

BIT_RUST_OBJECT_IMPORT="$PWD/native/target/release/bit-object-import" bit import <component-id>
BIT_RUST_OBJECT_IMPORT=control bit import <component-id>
BIT_RUST_OBJECT_IMPORT=off bit import <component-id>
```

The executable override must be an absolute path; use `.exe` on Windows. Unset the variable to restore the default path. It is independent of `BIT_RUST_DEPENDENCY_SCANNER`. There is no packaged discovery/installer for this prototype yet. Rust uses the existing workspace's exact inherited pnpm formatter, Clippy and perfectionist configurations; no lint exceptions were added.

## Protocol and limits

Input is a binary frame: `BOI1`, big-endian u32 request ID/count, then records of 20-byte SHA-1, big-endian u32 compressed length, and compressed bytes. Output is one versioned JSON line of ordered `source`/`legacy` results, identities and sizes. Node validates the complete response before allowing any native result to be persisted. Payloads are not base64 encoded.

Limits: 16 objects/128 MiB compressed per batch, 64 requests/256 MiB compressed outstanding in the coordinator, 1 GiB inflated per object, 256-byte Source header, 16 KiB response, 120-second batch timeout. Native decompression uses a reusable 64 KiB chunk per worker; the helper defaults to at most four workers. Input/output backpressure, protocol/crash/timeout fallback and bounded termination are tested. These are processing limits; existing upstream remote-stream buffers remain outside them. Exceeding eligibility limits uses the legacy path.

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
