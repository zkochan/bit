# Lossless replay before tar object processing

The experimental owned staging API now accepts an optional `replay(stream, { cause, signal })` callback. A byte/disk/admission/transport staging failure can fall back to the original stream without refetching it. Replay is permitted only before `consume()` starts. Native and canonical object policy cannot already have run at that boundary, so replay cannot repeat a completed merge or hook.

Normal Bit imports still use their existing path. The default qualification adapter still fails staging if no replay callback is supplied; the dedicated prefix qualification worker demonstrates the callback with the actual compiled canonical decoder. This change provides a tested prerequisite for production integration, not a runtime rollout flag or post-commit fallback mechanism.

## Exact byte progress

The transfer records acknowledged file bytes and the current chunk's acknowledged offset. It handles short writes explicitly and stops before writing a chunk that would exceed the archive limit. The original readable iterator is returned without destroying its unread tail. The spool writer closes before either native consumption or replay begins.

Replay emits the acknowledged private-file prefix, the unwritten remainder of the current chunk, then the unread original stream. If a transport error occurred, it also drains bytes still buffered in the destroyed input before raising that same error. This includes input buffered behind an in-flight disk write. A premature close without an error event retains the canonical `ERR_STREAM_PREMATURE_CLOSE`. No bytes are fetched again, and a disk error does not replace a later canonical decoding or transport error.

A queued transport failure cancels admission independently of caller cancellation. It can immediately replay its buffered prefix without acquiring another active staging slot. Caller cancellation and the operation deadline remain terminal and do not initiate replay. Cancellation during replay closes the original reader and the replay reader before deleting the stage. A successful callback must have consumed the replay to successful EOF; returning early cannot claim completion.

The existing limits still apply to the spool: 2 GiB per archive, four active stages, sixteen waiting admissions, and a deadline covering admission, transfer, native/canonical consumption and cleanup. Byte-limit fallback holds the rejected input chunk without copying it; it does not allocate another whole archive. The maximum input chunk and original readable buffering remain caller-controlled. Replay consumers must cooperate with the supplied signal and await their readers. Private files remain available throughout replay and are removed after reader closure.

Permanent boundary violations, such as a Git staging directory or non-byte input, do not initiate replay. With no replay callback, staging failures keep their existing failure behavior.

## Policy and error boundaries

A complete entry before a transport error is available to the canonical decoder during replay; the original terminal transport error still follows that prefix. START/END/ERROR, Ref creation, object order and all canonical parsing decisions remain in the existing decoder. Canonical decoding can reject an earlier member before the transport error, as it would while reading the original stream.

Once `consume()` starts, any failure is propagated after cleanup. Replaying an entire archive at that point could repeat mutable merges, queue reservations, hooks or cache/index updates. A later production coordinator must separately track processed descriptors, selected Sources, acknowledged/uncertain writes, and a safe remaining policy cursor. This change deliberately provides no post-policy replay.

## Validation and reproduction

Twelve portable unit tests cover exact prefix/chunk/tail bytes, partial disk writes and failed open, transport errors, buffered input behind a write, queued failure, premature close, no replay after policy, cancellation/deadlines, cancelled replay, mandatory EOF, and real aborted HTTP bytes. CI runs them with the existing staging/kernel tests on Linux, macOS and Windows.

The actual compiled decoder matches replay across all 23 archive cases forced through byte-limit fallback: ordered entries, error name/code/message, count and completion. Four interrupted HTTP cases cover partial header/body, an already complete Source followed by a partial header, and a transfer failing after valid END metadata. They retain the same received object prefix and original error; each operation invokes replay once and leaves no temporary stages.

```sh
node --test scripts/rust-object-import/tar-prefix-replay.test.cjs
BIT_LEGACY_ROOT=/tmp/private-compiled-bit \
  node scripts/rust-object-import/tar-prefix-qualification.cjs /tmp/private-compiled-bit
```

The helper's successful staged path and the full file/HTTP compatibility suites remain qualified separately. No new dependencies or Rust changes are needed. Generated archives, reports and logs stay outside Git under `$HOME/bit-object-tar-prefix-evidence-2026-10-09`.

## Successful-path cost after progress tracking

A fresh nine-round staging-inclusive loopback HTTP comparison on tmpfs, alternating control/candidate processes after warm-up and verifying every compressed Source byte, retains intake gains: many-small 106.8 → 46.3 ms, large-compressible 83.3 → 54.1 ms, random binary 68.5 → 36.1 ms. Intake medians improve 35–57%, startup-inclusive worker elapsed 13–26%, CPU 10–26%, and sampled simultaneous worker/helper RSS 5–20%. The same-worker fixture server/client and staging costs are included; this is Source-only intake against the compiled decoder/native batch importer, not a production full-command or JS control comparison. This run uses tmpfs; earlier Btrfs measurements keep their original staging-version provenance. The transfer module's hash is now included in benchmark stability checks.
