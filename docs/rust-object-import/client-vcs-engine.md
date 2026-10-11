# Rust client VCS engine

Umbrella issue: [#73](https://github.com/zkochan/bit/issues/73).

The target is a Rust engine owning client VCS operations: repository objects,
refs and indexes, history, workspace comparison and checkout, snapshots/tags,
merges, and fetch/push orchestration. TypeScript adapts Harmony extensions,
canonical component class metadata, installation/build tooling and presentation.
Work is grouped into substantial operation-level PRs.

## Checkout working branch

`rust-client-vcs-engine` starts from merged #72. Its current implementation adds
source-backed clean checkout/reset/revert preparation. `BIT_RUST_CLIENT_VCS=on`
and a selected object-import helper enable it. Merge paths retain canonical
loading. The new repository reader and object-to-workspace writer are reusable
engine foundations; the checkout milestone remains open.

A read-only `BWC0` request validates all Source objects in each bounded frame
before the adapter can remove workspace files. Each request has at most 64 files,
32 MiB compressed input and 32 MiB materialized output. The entire component is
preflighted before creating source-backed Vinyls. Rust verifies complete zlib
streams, Source header identity and SHA-1 of the raw body. Header sizes are not
used as byte lengths because canonical headers use decoded string lengths.

The adapter constructs the existing component metadata and defers SourceFile
contents. Original-byte source identity gives the existing file-status comparison
without loading the target contents. At the writer's final destination boundary,
`BWC1` reads stored Sources directly and performs canonical binary/EOL conversion
and in-place writes. Nested component ownership and live bitmap protection remain
with the existing writer. The helper acknowledges its completed prefix; Node
reaps it before replaying unfinished files through canonical writes.

Custom consumer/model/ref readers, active repository transforms, changed content
properties, pending objects and mutated cache contents retain canonical behavior.
Unchanged cached buffers are usable only when their actual bytes still hash to
the requested ref. Any ordinary consumer accessing a deferred contents property
hydrates the canonical Source and invalidates native provenance. Descriptors are
checked again at persistence so hooks and mutations cannot silently write old
bytes. Checkout owns the awaited persistence scope and reaps helpers on exit.

## Remaining work in this chunk

- Move version/ref resolution and validated Version manifests into the reusable
  Rust repository API.
- Move workspace comparison, protected-path handling and removal planning into
  the checkout operation, preserving the existing failure and hook boundaries.
- Consolidate operation state so preflight and persistence share verified Source
  data. The current foundation uses separate reads/inflation for these stages.
- Qualify modified/conflict, lane, workspace-root, hook and error behavior across
  the complete operation before opening the larger checkout PR.

The current implementation does not establish a speedup or default rollout.
Upstream component loading can still hydrate Sources, and repeated cache checks
hash cached bodies. Full-command performance qualification belongs to the larger
operation boundary.

## Current verification

The new qualification driver runs actual `checkout`, `checkout reset` and
`revert` against a real workspace and local remote scope. Its two versions have
distinct source bytes and file lists. It verifies workspace bytes, binary
preservation, added/removed/case-renamed files and bitmap version behavior, with
native, missing and crashed helpers. A separate diagnostic requires successful
native preflight and direct-source write acknowledgements. Recorded command
times are individual observations, not benchmark evidence.

The source and compiled tests additionally exercise custom loader behavior,
force-ours, live bitmap protection, corrupt/missing Sources before deletion,
contents-property replacement, ref mutation and bounded preflight fallback.
Generated CLIs, helper binaries, reports and logs stay outside Git under
`$HOME/bit-client-vcs-evidence-2026-10-11` and temporary owned directories.

The working checkpoint passes 68 source/adapter/regression tests, 50 physically
compiled checkout/persistence tests, 86 Rust workspace tests and canonical
TypeScript lint. Pinned Rust formatting, warning-denied Clippy, perfectionist
Dylint and rustdoc also pass. The final command report covers four modes (Node,
native, missing helper and crashed helper); this local qualification does not
replace the eventual operating-system CI and performance qualification.
