# Rust workspace file materialization

This stage starts from merged object-import PR #70, on the dedicated
`rust-workspace-materialization` base branch. `DataToPersist.persistAllToFS()` can
now use Rust to create parent directories and write actual workspace source files.
The existing deletion phase finishes first; linking starts only after all file
writes succeed. Capsule persistence keeps its existing implementation.

Enable the experimental path with both:

```sh
BIT_RUST_OBJECT_IMPORT=/absolute/path/to/bit-object-import \
BIT_RUST_WORKSPACE_MATERIALIZATION=on bit import component --override
```

An installed source-bound helper may also be selected with
`BIT_RUST_OBJECT_IMPORT=packaged`. Discovery uses the existing installed artifact
checks, never PATH or a runtime download. Trusted release provisioning accepts
successful exact-revision builds of the new base branch, alongside the existing
Rust base branches. The feature remains opt-in.

The `BWM1` protocol sends binary contents and absolute UTF-8 paths in frames of at
most 64 files and 32 MiB of contents plus paths. Rust validates the complete frame
before writing anything, creates parents once per frame, and writes in place.
Existing permissions, ownership, ACLs, hard links and symbolic-link targets are
therefore retained, matching `fs.outputFile`. New files use the process umask and
inherited directory metadata. `override=false` follows the canonical existence
check and skips existing targets. Empty and binary files are supported.

Node retains Bit's exact `isbinaryfile` classification and host newline conversion
before transferring bytes. File selection, nested-component ownership, bitmap
updates and model hydration remain in their existing layers. Files with custom
write methods, including atomic `JsonVinyl` and `License`, retain those methods;
native runs can resume after them. Oversized or unrepresentable files also use
their existing writer.

Each persistence operation owns a helper, with at most four helpers active across
operations. Frames remain within the caller's configured I/O concurrency chunks:
a failed chunk never starts files in the next chunk. The file list is snapshotted
before processing, matching the canonical pool. Rust acknowledges a completed
prefix and stops at its first filesystem error. Node reproduces the failed write
through the original method, preserving canonical error identity. Unsupported,
old, missing, crashed or malformed helpers fall back after termination and reaping;
unacknowledged writes are replayed only once the helper can no longer write. Each
frame has a 120-second deadline and termination escalates after 250 ms.

## Validation and measurements

Qualification runs the actual source and physically compiled `DataToPersist`
against the release helper. Coverage includes multiple frames, byte limits,
newline/binary parity, overwrite rules, deletion/link ordering, custom and atomic
writers, modes/inodes/links, canonical filesystem errors, concurrency failure
boundaries, file-list snapshots, old helpers, and late writes after malformed
acknowledgements. The Linux/macOS/Windows canonical graph CI jobs run both variants.
Rust protocol tests also reject incomplete and oversized frames before mutation.

Full-command comparisons use the same compiled CLI and helper in `workspace-node`
and `workspace-native` modes, changing only the materialization flag. The existing
import harness verifies all object/model/index readback, workspace bytes and bitmap
entries; installation runs additionally verify package versions and source links.
Separate diagnostic runs observe `BWM1` requests and acknowledgements, so a silent
fallback cannot count as native coverage. Warmups and diagnostics are excluded from
retained timings. CPU totals include child helpers; RSS is sampled simultaneously
across the client process tree. Fixture HTTP servers are excluded.

Results and reproduction will be recorded after retained runs finish. Generated
reports, profiles, binaries, private compiled graphs and logs stay outside Git.
