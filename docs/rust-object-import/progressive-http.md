# Progressive production HTTP tar intake

Owned HTTP staging now drives the BTI2/BTP1 client introduced in [progressive-tar.md](./progressive-tar.md). Rust can validate and persist complete batches while the original response is still arriving. Canonical JavaScript metadata hydration, merge/index decisions, Source reservations, hooks and acknowledgement-driven cache handling retain the existing repository adapter.

The path remains behind `BIT_RUST_OBJECT_TAR=on` plus a selected object-import helper. `BIT_RUST_OBJECT_TAR_PROGRESSIVE=off` selects the complete-transfer BTI1 control independently; unset it to use progressive intake within the tar experiment. Ordinary imports remain unchanged by default. Native Windows persistence, checkout/install/WAN qualification and rollout remain separate.

## Transfer, continuation and errors

Admission, private file permissions, the 2 GiB archive limit, four active stages, sixteen waiters and the operation deadline cover transfer, helper use, replay and cleanup. An empty owned archive exists before the helper starts. The producer appends each byte chunk with exact short-write offsets and publishes its new extent only after all writes finish. Successful input EOF declares final progress. The helper and its producer finish before the archive is removed.

Waiting for HTTP bytes uses abortable readable/end/error/close events rather than an iterator that destroys the transport on early return. A helper failure can therefore stop pending reads, close the spool writer, reap the child and settle/repair reserved Sources while leaving the unread original response available. The replay consists of the exact written extent, the unwritten current chunk and unread/buffered original bytes; it never refetches. The adapter's completed-object cursor skips metadata decisions and settled Sources already processed. Source repair or writable policy failures remain authoritative and terminal.

A transport error does not cancel the whole staging operation as a caller cancellation would. It stops production, then canonical replay processes any remaining complete received entries before reporting the original transport error with remote attribution. Caller cancellation and operation deadlines abort the producer/helper and suppress continuation. Native policy errors commit their selected prefix and propagate without replaying completed policy. A staging-read open failure before policy also uses the original response continuation. Replay must consume the original response to successful EOF before it can report completion.

The complete-transfer control shares the same byte reader and append implementation, so comparisons isolate overlap/progress coordination rather than unrelated staging implementations. Old helpers rejecting BTI2 retain canonical replay. Runtime packaging already binds the modified staging, transfer, importer and client modules; installations must be reassembled against the matching compiled runtime.

## Validation

Eight new portable ownership tests cover real HTTP persistence of sixteen exact Sources before server EOF, helper interruption during an idle read with an intact unread suffix, byte-limit replay, transport Error identity with destroyed or still-readable streams, cancellation, operation deadlines and canonical premature-close parity. Two Unix compatibility tests cover an older helper rejecting BTI2 while its producer waits for response bytes and a helper falsely reporting success before transport EOF.

Three compiled repository tests use a mixed metadata/Source prefix and check successful continuation, original transport failure, and a real helper process terminated after an acknowledgement. Metadata merges run exactly once, Source bytes match, and reservations remain unique. Existing compiled POST/token, HTTP failure/ENOSPC, repository and packaging tests also run against the production progressive path.

The diagnostics distinguish incoming inflation from later canonical repository rereads (which still contribute to total CPU/time). Canonical repository rereading remains part of the measured command.

The command driver adds `tar-staged` as an explicit complete-transfer control. Diagnostics wrap both tar clients and retain native Source/batch coverage, zero Source hydration, bounded Rust metadata hydration, zero fallback, canonical model/head/tag/index readback and repeated-import checks.

Local checks pass: 196 Node tests with one platform-specific skip, 60 Rust workspace tests, a genuine private Bit scope compilation and canonical `npm run lint`. The existing native matrix runs the portable ownership tests; compiled repository/HTTP tests remain in E2E shard 0. Rust sources, dependencies and inherited pnpm lint rules are unchanged, with no new exceptions.

## Genuine command measurements

The same five workload fixtures as [metadata qualification](./tar-metadata.md), Linux x64, Node 24.21.0, nine retained interleaved fresh-process rounds per mode after warm-up. Every cold and repeated command verifies Source bytes, canonical models, versions/tags/heads and indexes. Separate diagnostics verify full native Source coverage, zero Source hydration, zero native fallback and zero incoming metadata inflation. Subsequent canonical repository reads remain included. These are actual production HTTP `bit import --objects` commands, excluding checkout/install and WAN/authentication qualification.

Cold median milliseconds (JS compressed-buffer control, previous native importer, complete-transfer tar/Rust metadata, progressive tar/Rust metadata):

| Filesystem | Workload           | JS control | Native | Complete tar | Progressive tar |
| ---------- | ------------------ | ---------: | -----: | -----------: | --------------: |
| tmpfs      | Many small         |      620.7 |  491.5 |        466.2 |           425.0 |
| tmpfs      | Large compressible |      554.2 |  351.4 |        344.6 |           345.3 |
| tmpfs      | Large binary       |      418.8 |  376.8 |        368.3 |           347.3 |
| tmpfs      | Mutable heavy      |     1031.3 |  789.1 |        931.5 |           735.7 |
| tmpfs      | Multi-remote       |      498.0 |  340.8 |        309.0 |           303.6 |
| Btrfs      | Many small         |      619.1 |  482.2 |        467.6 |           422.7 |
| Btrfs      | Large compressible |      556.9 |  347.7 |        343.2 |           337.4 |
| Btrfs      | Large binary       |      403.6 |  368.3 |        361.0 |           339.7 |
| Btrfs      | Mutable heavy      |     1086.2 |  865.1 |       1027.0 |           812.7 |
| Btrfs      | Multi-remote       |      488.2 |  344.6 |        305.7 |           308.8 |

On tmpfs, progressive mutable-heavy commands improve 21.0% over complete staging, 6.8% over previous native and 28.7% over JS. Their interquartile wall-time ranges are 722–746 ms progressive, 930–941 ms complete tar and 782–796 ms native. Many-small improves 8.8% over complete staging but has greater observed variation. Large binary improves 5.7%; large-compressible and multi-remote differences between tar paths are small. Repeated imports show no material benefit.

Btrfs mutable-heavy improves 20.9% over complete staging, 6.1% over previous native and 25.2% over JS; interquartile ranges are 798–818 ms progressive, 1022–1045 ms complete tar and 852–888 ms native. Many-small improves 9.6% over complete staging and large binary 5.9%. Large-compressible and multi-remote remain effectively flat between tar paths. Across the five fixtures and both filesystems, progressive cold commands improve 16–39% versus JS, with no material warm-command gain.

Overlap is not a CPU/RSS reduction guarantee. Mutable-heavy tmpfs median client/helper CPU seconds and sampled simultaneous process-tree RSS MiB, in the same mode order, are 1.44 / 300.1, 1.19 / 291.1, 1.07 / 226.3 and 1.11 / 248.1. Progressive wall time improves while CPU and RSS rise relative to complete staging. Separate diagnostics reduce filesystem callbacks from 10,720 to 9,333 and Promise callbacks from 146,538 to 137,112 for that comparison. GNU time includes waited helper CPU; 10 ms RSS sampling excludes the server, filesystem cache and staged bytes. Nested stage diagnostics are not additive.

Mutable-heavy Btrfs CPU seconds / sampled RSS MiB in the same order are 1.48 / 308.3, 1.27 / 295.4, 1.16 / 238.7 and 1.20 / 240.7. Filesystem callbacks are 10,796 complete tar and 10,928 progressive; Promise callbacks are 147,137 and 139,118. Overlap improves wall time on disk, with a small CPU increase and no established RSS benefit over complete staging. Callback reductions are not uniform across filesystems.

Keep tar opt-in: these fixtures do not establish broader workload/platform/ACL, checkout/install or WAN rollout. Native merge/index kernels, trusted automatic releases and operation orchestration remain separate work. Raw provenance stores exact source/module/helper hashes; helper SHA-256 is `71cede471917682eb3597fcd3bd0ba3bcc89e3f4f5e7cdabd944feb41423a07b`. Superseded exploratory runs are excluded from these retained results.

Reproduce genuine objects-only HTTP commands with a separately compiled CLI:

```sh
BIT_IMPORT_QUALIFICATION_TRANSPORT=http \
BIT_IMPORT_QUALIFICATION_MODES=control,native,tar-staged,tar \
BIT_IMPORT_QUALIFICATION_ROUNDS=9 \
BIT_IMPORT_QUALIFICATION_REPORT="$HOME/bit-progressive-http-results.json" \
node --expose-gc scripts/rust-object-import/import-qualification.cjs \
  /absolute/private-compiled-bit /absolute/bit-object-import
```

Set `BIT_IMPORT_QUALIFICATION_TMPDIR` to a scratch directory on the intended filesystem. Raw evidence, archives and logs stay outside Git in `$HOME/bit-progressive-http-evidence-2026-10-09`.
