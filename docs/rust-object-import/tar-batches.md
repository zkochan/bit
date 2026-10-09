# Experimental Rust tar batches

The native helper now exposes a staged-archive kernel combining tar framing, bounded Source validation and selected Source persistence. Normal Bit imports do not invoke it. The CJS client and worker are qualification tools; they do not replace `ObjectFetcher`, repository queues, mutable merges, cache invalidation, hooks or indexes.

## Selection before persistence

A caller owns an immutable regular archive file outside the repository, using an absolute path. The archive is separate from RPC stdin, so archive bytes cannot block commit acknowledgements. Rust returns ordered batches of at most 16 entries and 128 MiB of compressed bodies. Each descriptor contains the tar name, body offset and size, Source validation when eligible, and marker text. Compressed Source buffers stay in Rust. Non-Source bodies can be read by the host at the reported range for canonical processing.

The host processes descriptors in order and explicitly selects validated Sources. Rust validates the complete selection before writing anything: request and sequence identities must match, indices must be unique and in range, and each selection must be a validated Source. Only then does the existing native store persist selected compressed bytes and report successes and failures. A later host error can commit the preceding selected Source prefix and then propagate; later Sources remain unselected. An acknowledgement is not an import transaction: earlier batches can already have written objects when a later batch fails.

Marker JSON parsing and Ref policy remain in Node. The qualification adapter reproduces the decoder's last START, truthy END for schema `1.0.0`, remote ERROR, unknown-member and first-two-name-parts behavior. A terminal frame ends native framing; successful import completion also requires host policy, valid commit acknowledgements and actual successful helper exit.

## Protocol and bounds

All RPC words are unsigned big-endian 32-bit values. `BTI1` is followed by a positive request ID, flags (0 or 1; bit 0 requests compressed-body SHA-1), UTF-8 path byte length and path. Each newline-delimited JSON batch carries version 1, ID, sequence, `done`, `fallback`, `error` and `files`. `BTC1` carries ID, sequence, selected-index count and indices. Its JSON acknowledgement carries version, ID, sequence, `persisted` and `failed`. The next batch follows its acknowledgement; an empty terminal batch uses the next sequence.

Limits: path 4,096 bytes; archive 2 GiB; 1,048,576 ordinary/marker entries; one body 128 MiB; extension and raw marker body 64 KiB; JSON frame 8 MiB. Existing Source inflater limits also apply. Advertised truncated bodies are rejected before allocating them. Complete bodies preceding missing padding remain visible before the canonical truncation error. The helper does not extract tar paths.

The parser supports the qualified canonical octal USTAR/GNU subset, local/global PAX and GNU long names, zero blocks and concatenated archives. It preserves the installed decoder's global-PAX-until-local-PAX behavior and directory empty-body behavior. Noncanonical numeric encodings, unsupported extensions, oversized input and resource failures require fallback; this is not a general tar extractor or universal tar compatibility claim. A caller must preserve the private archive's ownership and immutability throughout the operation; opening a pathname is not an atomic snapshot guarantee.

The client validates bounded frames, offsets, identities, Source selections and acknowledgement coverage. Its operation deadline also covers a stalled host callback. Failure terminates and reaps the helper before returning, escalating termination after 250 ms. Late output or failed exit rejects completion. Callbacks themselves must cooperate with cancellation; the client prevents a later native commit but cannot undo host-side work.

## Reproduce

```sh
cd native
cargo build --locked -p bit-object-import
cd ..
node --test scripts/rust-object-import/tar-batches.test.cjs
BIT_TEST_OBJECT_IMPORT="$PWD/native/target/debug/bit-object-import" \
  node scripts/rust-object-import/tar-intake-qualification.cjs \
  /tmp/private-compiled-bit "$PWD/scripts/rust-object-import/tar-batch-worker.cjs"
```

All 23 existing differential cases match the actual compiled decoder, including the eight mismatches in the previous external experiment. Eight new Rust tests cover selection, framing, prefix progress and resource limits; nine Node tests cover byte offsets, ordering, markers, host errors, deadlines and persistence failures. CI runs these against real helpers on Linux, macOS and Windows. These tests do not promote Windows native writes in the normal repository API.

Source-only performance comparisons use an already staged file, the actual compiled decoder plus previous native batch importer as control, alternating fresh processes after warm-up, sequential storage runs and byte-for-byte verification of every persisted object. HTTP transfer and staging costs, canonical metadata policy and full-command gains are not measured. Raw evidence remains outside Git.

## Remaining integration

Normal imports still need owned HTTP/file staging with bounded disk use, canonical metadata payload processing, repository queue reservations, hook/index/cache handling for partial acknowledgements, cancellation propagation, and lossless fallback replay that does not repeat completed policy mutations. Mixed/mutable-heavy archives, actual file and original HTTP-tar commands, platform ACL behavior and the JS compressed-buffer control must be qualified before enabling this kernel for users. No new runtime opt-in flag is introduced by this change.

## Linux operation measurements (2026-10-09)

Nine alternating fresh-process rounds after warm-up on each filesystem, with sequential control/candidate runs and complete compressed-byte readback:

| Workload                         | tmpfs intake ms, control → kernel | Btrfs intake ms, control → kernel |
| -------------------------------- | --------------------------------- | --------------------------------- |
| 4,096 × 1 KiB Sources            | 103.0 → 33.3                      | 137.0 → 70.5                      |
| 32 × 8 MiB compressible Sources  | 77.6 → 44.1                       | 78.2 → 44.3                       |
| 16 × 1 MiB random binary Sources | 53.9 → 13.1                       | 54.5 → 13.7                       |

Intake medians improve 43–76% on tmpfs and 43–75% on Btrfs. Startup-inclusive worker elapsed improves 15–29%, whole Node/helper CPU 11–31%, and sampled simultaneous process-tree RSS 7–19%. This includes the selection handshake. The control is the previous compiled Node tar decoder/native batch importer; both receive an already staged file. No HTTP/spooling/full-command improvement is established. Sampled RSS is not a universal peak-memory bound.

Evidence is outside Git at `$HOME/bit-object-tar-batches-evidence-2026-10-09`, including binary, client and adapter fingerprints. Reproduce with `BIT_TEST_OBJECT_IMPORT` pointing to the new release helper and the qualification adapter as the benchmark candidate. Use `BIT_TAR_QUALIFICATION_DIRECTORY` for an external Btrfs directory. These results qualify further integration work, not enabling the kernel in ordinary imports.

The qualification adapter's owned-file staging and cancellation lifecycle, including staging-inclusive loopback HTTP comparisons, are documented in [tar-staging.md](./tar-staging.md). Ordinary imports still need partial-progress and policy-aware replay integration.
