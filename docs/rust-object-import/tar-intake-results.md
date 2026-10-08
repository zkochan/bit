# Tar intake qualification

A Source-only Rust intake prototype shows enough benefit to pursue a combined tar/validation/persistence operation. It is not integrated into normal imports. The committed changes are canonical decoder unit tests, small generated-in-memory differential fixtures and qualification drivers. Prototype source, generated archives, JSON, logs and object stores stay outside Git in `$HOME/bit-object-tar-evidence-2026-10-09`.

## Compatibility contract

The original `ObjectList.fromTarToObjectStream()` remains the oracle. Its behavior is broader than the normal encoder's output:

- Unknown members become objects, including empty buffers. Scope/ref use the first two slash-separated name segments. Empty refs throw; members are not extraction paths.
- Schema `1.0.0` requires a truthy END marker. Other schemas and legacy archives do not. The last START wins; END can precede START. Counts and scope names in END are not validated.
- Complete objects can be emitted before a later error. `.BIT.ERROR` preserves the remote message and stops before subsequent members. Missing END includes the JSON-serialized START metadata in its error.
- Concatenated archives continue after zero blocks. Complete entries can omit terminal zero blocks. Truncated bodies and partial trailing headers fail. PAX/GNU filename handling must match the installed decoder.

Twelve new compiled unit tests freeze these behaviors. The differential driver exercises 23 cases against the actual compiled Bit decoder, including real GNU type flags, PAX global headers, directory/empty-ref members, falsy END markers and malformed START JSON. It reports entry/error/completion parity separately instead of accepting a partial response as success.

The external prototype uses pinned [`tar` 0.4.46 entry traversal](https://docs.rs/tar/0.4.46/tar/struct.Archive.html#method.entries), never archive extraction, and the current production Source validator/store. It processes at most 16 objects and 128 MiB of compressed batch input with four workers. Explicit entry/body and total-object limits exist, but extension-header allocation, marker bounds, cancellation and the policy/commit boundary still need qualification. It must not process ordinary user imports yet.

Differential checks found mismatches in checksum/trailing-header error messages, global PAX path behavior, falsy END handling, malformed JSON error text and directory/empty-ref handling. An initial truncated-body result incorrectly exposed partial entry bytes; the prototype now checks the entire advertised body before reporting an entry. Passing common archives alone does not establish error compatibility.

## Source-only measurements

Linux x64, Node 24.21.0, nine alternating fresh-process runs per mode after a discarded warm-up. Storage runs execute sequentially. Performance inputs come from tar-stream's encoder using Bit's Source format and distinct content identities; separate compatibility fixtures also cover empty and Unicode content. Each retained run verifies every persisted compressed byte and checks for extra/temporary files, then removes its disposable object directory outside the measurement.

The comparison is the original compiled tar decoder feeding the existing four-worker Rust batch importer, versus a combined four-worker Rust tar/Source-validation/persistence prototype. Both worker processes load the same compiled Bit graph before timing intake. The current native importer is the control here; these are not comparisons against legacy recompression or the JS compressed-buffer control.

| Storage | Source workload          | Current intake ms | Prototype ms | Faster |
| ------- | ------------------------ | ----------------: | -----------: | -----: |
| tmpfs   | 4,096 × 1 KiB            |             107.4 |         23.1 |    78% |
| Btrfs   | 4,096 × 1 KiB            |             163.0 |         71.6 |    56% |
| tmpfs   | 32 × 8 MiB compressible  |              80.8 |         44.6 |    45% |
| Btrfs   | 32 × 8 MiB compressible  |              80.4 |         44.5 |    45% |
| tmpfs   | 16 × 1 MiB random binary |              56.9 |         19.3 |    66% |
| Btrfs   | 16 × 1 MiB random binary |              60.2 |         21.6 |    64% |

Whole-worker startup-inclusive elapsed medians improve 16–34%, total Node/helper CPU medians improve 10–35%, and near-simultaneously sampled Node/helper RSS medians fall 7–21%. `/usr/bin/time` includes waited-for helper CPU; the process-tree sampler includes observed helper RSS. Sampling is not an exact peak-memory bound. Fixture generation, readback and directory cleanup are outside timing.

These are Source-only operation results, not `bit import` speedups. The prototype writes validated Sources without the canonical queue/merge/hook decisions and does not implement metadata hydration, import deduplication, cache/index coherence or full-command fallback. Mixed archives, metadata-heavy imports, file/original HTTP-tar commands, invalid/cancelled streams and all supported platforms remain required before integration.

## Reproduction

Run canonical-only qualification with a physical compiled private CLI:

```sh
BIT_LEGACY_ROOT=/path/to/private-cli \
  node scripts/rust-object-import/tar-intake-qualification.cjs /path/to/private-cli
```

Pass an external candidate executable as the second argument for differential qualification. Any entry/error/completion mismatch makes the driver exit nonzero by default; `BIT_TAR_QUALIFICATION_ALLOW_MISMATCH=1` permits exploratory reporting without treating the candidate as qualified. Its `probe` mode reads tar on stdin, emits bounded entry summaries as JSON lines, emits a final `done: true` summary only on completion, and exits nonzero on errors. Summaries include original name, complete buffer size and SHA-1 of compressed bytes. The local candidate source/build logs are retained with the external evidence; the repository does not distribute that experiment.

For Source-only measurement, the candidate's `store <absolute-directory>` mode consumes tar and returns completed object/Source counts. The existing helper must be a release build:

```sh
BIT_LEGACY_ROOT=/path/to/private-cli \
BIT_TAR_QUALIFICATION_DIRECTORY=/path/to/external-evidence \
  node scripts/rust-object-import/tar-intake-benchmark.cjs \
    /path/to/private-cli /path/to/release/bit-object-import /path/to/candidate
```

Defaults are nine rounds and all three workloads. `BIT_TAR_QUALIFICATION_CASES` selects comma-separated workloads; `BIT_TAR_QUALIFICATION_ROUNDS` controls rounds. Whole-process measurement currently requires Linux. Run storage comparisons sequentially. Qualification/benchmark workers and generated inputs stay outside source directories.

## Integration boundary

Rust should return a bounded batch of validated Source handles and canonical metadata/fallback payloads. Node must retain ordered selection, queue deduplication and mutable/model policy, then acknowledge selected Source handles before Rust commits them. A metadata failure must stop later Source commits just as it does today. Hooks/overrides need their existing compatibility path; cache invalidation follows confirmed persistence.

Input backpressure and commit acknowledgement need independent, bounded progress: queueing more tar bytes ahead of a commit on the same blocked pipe can deadlock. Cancellation must close input, reap the helper and clean staging before canonical retry; a consumed HTTP body needs a lossless replay/staging strategy for whole-operation fallback. Missing END, remote errors, truncated bodies and helper failure never produce a completed import acknowledgement. Qualify this boundary before moving component/index transactions or changing rollout.
