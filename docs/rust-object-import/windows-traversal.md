# Windows object-store traversal

Eligible Windows stores can now enumerate references and classify compressed headers in one Rust operation, using the existing BWR1/BWD1 protocols. Native selection remains opt-in through `BIT_RUST_OBJECT_IMPORT`; `BIT_RUST_OBJECT_TRAVERSAL=off` restores canonical enumeration. Native writes retain their existing platform restrictions.

Only layouts containing all 256 lowercase two-hex prefix directories qualify. Unknown visible root directories, redirects, uppercase or unusual leaf names, incomplete layouts, inaccessible paths and helper/protocol failures retain whole-operation fallback. Node checks the prefix layout; Rust independently checks that its prefix snapshot matches the request. The Windows junction test covers rejection at both boundaries without requiring symlink privileges.

References remain in descending hash order. Hidden entries are ignored, while hash-shaped leaf directories remain visible and receive canonical unreadable fallback during classification. A late layout error discards earlier frames. Native header timestamp compatibility and registry/transformer/custom-method policies remain as described in [windows-headers.md](./windows-headers.md). Concurrent mutations remain visible to subsequent operations; no atomic snapshot or content cache is promised.

The existing limits remain: 4,096 entries per response frame, 65,536 entries per prefix, 1,048,576 objects per operation and a 4 MiB response-line bound. A final empty completion frame is mandatory. A failed operation releases the shared helper slot only after actual process/pipe closure. No per-file Node callback is introduced into traversal.

## Qualification

Windows platform tests now execute a 4,100-file multi-frame traversal, creation/deletion checks, exact combined-header size/mtime comparisons, malformed requests and conservative layout fallback. Portable response tests cover fragmented pipe chunks, missing completion, sequence errors, duplicate objects, trailing data, explicit fallback and nonzero exits on every OS. Unix permission and unprivileged-symlink cases remain Unix-only; Windows junctions have their own real test.

Packaged-helper tests exercise combined traversal on Windows at Node 22.13, 22.22 and 24. Local compiled Bit scope/readback and Windows CI results are recorded in the PR. Windows full-command/ACL/performance qualification remains open. This change makes no Windows speedup or full Rust parity claim. Generated artifacts and reports stay outside Git.
