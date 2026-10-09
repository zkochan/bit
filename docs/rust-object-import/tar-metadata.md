# Bounded native metadata in HTTP tar imports

The staged HTTP tar path now asks Rust to inflate metadata as well as validate Sources. JavaScript hydrates the returned UTF-8 bytes through the existing BitObject parser and retains merge decisions, queue ordering, caches, hooks and indexes. Eligible metadata no longer needs a Node archive range read or zlib inflation. The complete tar path remains opt-in.

## Protocol and eligibility

BTI1 request flags are a bitmask: bit 0 requests the compressed-entry digest and bit 1 requests metadata. Flags 0/1 retain their existing behavior. New clients with an older helper receive a request rejection and replay the same archive through canonical decoding before repository policy begins; no refetch is required. Source commit selection still accepts only validated Sources, never metadata.

The existing native metadata validator only returns losslessly decoded UTF-8 with a complete zlib terminator/checksum, no trailing compressed bytes, and at most 256 KiB inflated per object. It does not parse JSON or change accepted model representations. Invalid, truncated, non-UTF-8, oversized and invalid-Source inputs retain legacy descriptors. Metadata text retains the complete header and NUL separator. JavaScript validates response identity, status, byte length and limit before invoking repository policy; unsolicited metadata is rejected.

A batch returns at most 512 KiB of inflated metadata text. Additional metadata entries retain their ordered compressed-range descriptors and use canonical Node processing. Up to 16 bounded metadata results can exist transiently during parallel validation before this response budget is applied. The existing 8 MiB JSON frame limit remains authoritative, including escaping and names; a response exceeding it requests canonical continuation through helper failure.

ObjectsWritable rechecks repository method/hook eligibility before using each metadata result, since earlier merges may install a transformer. Ineligible metadata reads its original compressed range. Canonical parser errors remain authoritative and preserve the accepted Source prefix. A helper failure after completed metadata policy skips that processed prefix during replay, preserving exactly-once merges and settled Source repair behavior.

## Controls

Production HTTP tar intake remains enabled only with `BIT_RUST_OBJECT_TAR=on` and a selected helper. Within that path, `BIT_RUST_OBJECT_IMPORT_METADATA=off` restores metadata range reads and Node inflation independently. The direct staged adapter also accepts `metadata: false`; the low-level protocol client requests metadata only with `metadata: true`. Unsupported repository hooks, platforms and transport paths retain existing processing.

## Validation

Rust tests cover old flag behavior, combined digest/metadata flags, Unicode/NUL preservation, the inclusive object and batch budgets, unknown flags and rejection of metadata Source selections. Portable protocol tests cover malformed/truncated/non-UTF-8/oversized input and invalid Source identity, plus hostile or unsolicited metadata responses rejected before policy.

Compiled repository tests verify mixed Source/VersionHistory intake without any Node range load, canonical parser error identity with an accepted Source prefix, active and dynamically installed hooks, older helper replay before native policy, and both metadata-off controls. Existing original HTTP interruption, staging failure, cancellation, suffix repair and packaged selection coverage continues to pass.

Local checks: 54 Rust workspace tests, 96 portable helper tests with one Windows-only skip, all 34 compiled repository/HTTP tests with the real helper and release artifact, and all 24 artifact/discovery tests pass. Canonical isolated `npm run lint`, pnpm's pinned Rust formatter, Clippy, perfectionist Dylint and rustdoc pass without new exceptions. Tests join the existing native platform matrix and compiled repository step.

## Command qualification

The genuine HTTP harness adds `tar-node-metadata` alongside `control,native,tar`. It uses the same compiled code and helper with metadata disabled, isolating this stage from tar intake and earlier native work. Separate diagnostics require native Source coverage and, for the new tar mode, zero legacy inflation and canonical hydration of all eligible metadata. Retained timing commands have no trace instrumentation. Every cold/warm command verifies Source contents, models, versions, tags, heads and indexes; raw results stay outside Git.

The final code was qualified on Linux x64, Node 24.21.0, with genuine scopes and production HTTP objects-only import commands. Each filesystem uses one warm-up and nine retained rounds with rotating four-mode order, plus separate diagnostics. Both runs use identical compiled-module, harness and helper fingerprints. TMPDIR places staging, scope data and destinations on the measured filesystem. These are fresh destinations, not cold OS/server caches. Datasets and measurement limits match [http-command-results.md](./http-command-results.md).

Median cold elapsed milliseconds: JS = compressed-buffer control; native = previous object path; tar/Node = staged tar with metadata disabled; tar/Rust = staged tar with metadata enabled.

| tmpfs                  |      JS |  Native | Tar/Node | Tar/Rust |
| ---------------------- | ------: | ------: | -------: | -------: |
| Many small             | 579.794 | 443.445 |  460.738 |  435.317 |
| Large compressible     | 543.461 | 333.342 |  335.021 |  328.331 |
| Large binary           | 399.233 | 364.312 |  360.280 |  355.528 |
| Mutable heavy          | 993.982 | 775.863 | 1126.047 |  934.221 |
| Two concurrent remotes | 473.945 | 339.345 |  306.874 |  298.776 |

| btrfs                  |       JS |  Native | Tar/Node | Tar/Rust |
| ---------------------- | -------: | ------: | -------: | -------: |
| Many small             |  625.034 | 480.466 |  500.059 |  472.218 |
| Large compressible     |  552.633 | 349.498 |  350.855 |  341.099 |
| Large binary           |  414.301 | 372.461 |  370.905 |  365.602 |
| Mutable heavy          | 1090.569 | 874.970 | 1256.429 | 1037.062 |
| Two concurrent remotes |  487.528 | 348.897 |  316.485 |  311.283 |

Rust metadata improves the mutable-heavy fixture by 17.0% on tmpfs and 17.5% on Btrfs relative to tar/Node. The new path is 6.0% and 4.9% faster than JS, removing the measured regression against that control. It remains 20.4% and 18.5% slower than native; tar should stay opt-in. Mutable-heavy cold median absolute deviations are 16.5/11.6/11.2/9.1 ms (tmpfs) and 11.2/2.7/38.1/13.6 ms (btrfs) in column order.

Many-small improves about 5.5% versus tar/Node on both filesystems. Large-compressible, binary and concurrent-remote differences versus tar/Node are smaller (about 1–3%); their small median differences do not establish universal gains. Relative to native, the new path is about 2% faster for many-small, 1–3% for compressible/binary, and 10–12% for concurrent remotes. Warm imports correctly commit zero Sources and show no material gain.

Mutable-heavy client CPU seconds and sampled process-tree RSS MiB (same column order):

| Filesystem |                 JS |             Native |           Tar/Node |           Tar/Rust |
| ---------- | -----------------: | -----------------: | -----------------: | -----------------: |
| tmpfs      | 1.37 s / 299.7 MiB | 1.14 s / 289.1 MiB | 1.28 s / 300.2 MiB | 1.03 s / 255.3 MiB |
| btrfs      | 1.48 s / 300.9 MiB | 1.26 s / 296.8 MiB | 1.40 s / 299.1 MiB | 1.15 s / 226.4 MiB |

GNU time includes waited client helper children, excluding the server. RSS is sampled every 10 ms and excludes server memory, filesystem cache and staged bytes. It is not machine-wide peak memory; CPU resolution is 0.01 seconds. CPU and RSS improve while the wall-time gap to native remains, so these metrics alone are insufficient for rollout.

Separate tmpfs diagnostic callbacks and canonical legacy inflation calls:

| Fixture/path                | Filesystem callbacks | Zlib callbacks | Legacy inflation calls |
| --------------------------- | -------------------: | -------------: | ---------------------: |
| Many small/Node metadata    |                2,076 |          1,004 |                    401 |
| Many small/Rust metadata    |                1,663 |            202 |                      0 |
| Mutable heavy/Node metadata |               15,867 |          9,364 |                  4,281 |
| Mutable heavy/Rust metadata |               10,736 |            802 |                      0 |

Every retained and diagnostic cold/warm command passed full Source/model/version/tag/head/index verification. The new tar path hydrates all eligible metadata canonically, validates the expected native Source count, hydrates zero Sources in Node, and has zero native fallback. Diagnostics are absent from timing commands. A partial run before the final response guards was discarded and is excluded from these results.

Reproduce with a separately compiled CLI containing this integration:

```sh
BIT_IMPORT_QUALIFICATION_TRANSPORT=http \
BIT_IMPORT_QUALIFICATION_MODES=control,native,tar-node-metadata,tar \
BIT_IMPORT_QUALIFICATION_ROUNDS=9 \
BIT_IMPORT_QUALIFICATION_REPORT="$HOME/bit-tar-metadata-results.json" \
node --expose-gc scripts/rust-object-import/import-qualification.cjs \
  /absolute/private-compiled-bit /absolute/bit-object-import
```

For Btrfs, set TMPDIR to a scratch directory on that filesystem. Raw local evidence and release artifact remain in `$HOME/bit-tar-metadata-evidence-2026-10-09`, outside Git. Helper SHA-256: `0d70a7eb4b4d37f4ebbafd32bfa8a9ec867867141f847eb396eeac47c45369ec`. Raw provenance identifies the base merge and records actual copied source/module hashes; the measurements use the current metadata implementation.

Next profile and reduce staging and per-object coordination costs, retaining bounded original-prefix replay, cancellation and hook/merge/index semantics. Repeat this four-mode command qualification before considering default enablement. Native merges/index transactions, automatic trusted releases and broader platform/ACL/checkout/install qualification remain open.
