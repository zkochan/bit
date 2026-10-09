# Progressive Rust tar intake

The staged HTTP path waits for the complete archive before Rust parses and persists it. The previous native path overlaps transfer with persistence. In the mutable-heavy tmpfs diagnostic from the [metadata qualification](./tar-metadata.md), native tar intake took about 651 ms and its protocol operation about 378 ms. Their roughly 273 ms difference identifies staging as a useful next target; these nested diagnostics are not additive command stages or a prediction of the resulting speedup.

The helper now supports an append-only archive with explicitly published byte prefixes. `readProgressiveTarBatches` exposes this capability separately from the existing `readTarBatches`. PR #58 introduced this kernel/client foundation without changing production HTTP. The follow-on [production HTTP integration](./progressive-http.md) connects owned staging to this client; tar remains opt-in.

## Protocol

BTI1 remains unchanged. BTI2 uses the same request layout: four-byte magic, request ID (u32), flags (u32), path byte length (u32), and UTF-8 absolute path. Integers are big endian; flags retain the existing digest and metadata bits.

The producer sends BTP1 frames containing four-byte magic, request ID (u32), available bytes (u64), and completion (u32, zero or one). Prefix lengths must be monotonic and at most 2 GiB. Completion explicitly declares the final readable extent. Updates after completion, invalid IDs, and invalid extents are rejected.

Rust reads only published bytes, even if the file already contains additional data. At the prefix boundary it blocks on the next stdin progress frame, without polling. Published bytes that are missing from the file fail the operation. Progress frames can also arrive while Rust awaits the existing BTC1 Source selection; acknowledgements keep their existing ordering and repair rules. Batches retain the 16-record, compressed-byte, and metadata limits. Paths, tar extensions, offsets, validation, hashes, and Source-only native writes use the existing implementation.

## Ownership and cancellation

The caller owns a private, regular, append-only archive and its cleanup. Append writes must finish before publishing their resulting extent. This API does not create or delete the archive, own the HTTP stream, or provide automatic canonical replay.

The progress factory receives an AbortSignal and returns an async iterable of `{ bytes }` updates. It must stop pending work when aborted and complete cleanup in its iterator finalizer. Normal iterator completion publishes final EOF. Producer failures preserve their Error identity; helper failures, timeout, cancellation, and host policy failures abort the producer and reap the child before returning. With `awaitSelection`, active host selection cleanup is also awaited. Callers must not delete the archive while the helper or producer is still using it.

A complete Source preceding truncated padding remains eligible for the existing prefix commit before the canonical truncation error. Host policy errors commit only the selected prefix. Hidden suffix bytes beyond the declared EOF never reach policy.

## Validation and remaining integration

Six new Rust tests cover progress framing, fragmented reads, explicit EOF, malformed updates, bounds, and changed prefixes. Eight portable client tests use the real helper, including an actual growing archive: the first 16 Sources are acknowledged and their exact compressed files verified before the producer appends the remaining 17 Sources. Other tests cover Unicode metadata, fragmented headers and bodies, producer failure, timeout, host policy errors, hidden suffixes, invalid progress, and cancellation during active selection and production.

The workspace Rust tests, pinned pnpm formatting, Clippy, warning-denied perfectionist Dylint, and rustdoc checks pass. Portable tests are included in the existing native platform matrix. Local raw logs and release archives stay outside Git in `$HOME/bit-progressive-tar-evidence-2026-10-09` and `/tmp/bit-progressive-*.log`.

The follow-on [production HTTP integration](./progressive-http.md) connects the progressive producer to owned staging with received-prefix replay, the processed cursor, transport errors, cancellation and canonical policy, and repeats genuine HTTP command qualification. Native merge/index work, trusted release provisioning, and broader platform qualification remain separate open tasks.
