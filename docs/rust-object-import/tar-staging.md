# Owned staging for the experimental tar kernel

The tar qualification adapter now uses a shared owned-file staging boundary. It bounds disk use and concurrent staging, propagates cancellation into the native helper, and removes temporary files after consumption and helper reaping. Normal Bit imports still do not call this interface.

`withStagedArchive(input, options, consume)` takes exclusive ownership of an unconsumed byte stream. It waits for admission, writes a private archive with normal stream backpressure, then calls `consume({ archive, bytes, signal })`. The callback must retain the archive's immutability, use the provided signal, and await every reader/helper before returning. The native client observes that signal even while host selection is stalled, terminates the helper, escalates after 250 ms if necessary, and waits for actual exit. Only then does the staging boundary remove the directory and release admission.

The default limit is 2 GiB per archive, matching the Rust parser. Four stages may be active and sixteen may wait in one Node process. Admission includes archive consumption and cleanup, so the bound covers files still held by a helper. The maximum staged-file budget is therefore 8 GiB per process; it is not a machine-wide or free-space reservation. Waiting inputs are not consumed. Queue overflow, disk errors, oversized input and cancellation fail this qualification operation; they do not silently retry a partially consumed input.

A 120-second default deadline includes admission, transfer and consumption. Cancellation also rejects a callback's successful result if cancellation happened before its return. Generic consumers must cooperate with cancellation: deleting a file while an uncooperative reader still owns it would be unsafe. Both the helper client and qualification adapter satisfy the cooperative contract.

Temporary directories and files have Unix modes 0700 and 0600; Windows uses inherited platform ACLs and requires separate production ACL qualification. Files are opened exclusively. Physical staging paths with a Git ancestor are rejected, including worktree `.git` files. The utility creates no fixtures or reports in the repository. Cleanup runs on success, transport/consumer failure, timeout and cancellation, with bounded Windows removal retries. Admission is released even if cleanup itself fails; that failure remains visible to the caller.

## Semantics before production integration

Whole-archive staging waits for successful transfer completion before object processing. A transport failure or staging limit currently discards the incomplete stage without processing its complete-entry prefix. The existing streaming decoder can already have emitted that prefix. Ordinary imports therefore retain their existing path. Production integration must preserve partial progress, error attribution and lossless fallback without refetching or repeating completed mutable policy. Successful byte transfer also does not establish Bit import completion: START/END/ERROR policy and successful helper exit remain required.

Native failure after processing a fully staged archive can leave selected Sources from earlier batches persisted. The private file is cleaned, but those object writes are not rolled back. Repository queues, cache/hook/index policy and replay cursors are still needed before exposing this path through `ObjectFetcher`.

## Qualification

Ten portable tests cover exact binary staging and permissions, size/error cleanup, stalled transfers, external cancellation during host selection, bounded active/waiting admission, Git directory rejection, real interrupted HTTP streams, marker failure after a persisted Source prefix, cancellation before successful return, and authenticated fixture HTTP success through the native store. CI runs them with real helpers on Linux, macOS and Windows.

The 23-case differential archive corpus also passes through real loopback HTTP response streams for both the actual compiled decoder and the staged kernel. The disposable server requires a fixture bearer token; it is not Bit's production authenticated HTTP client. It runs in the measured worker, so its server/client CPU and memory are included in operation comparisons. This establishes complete-transfer decoder contracts, not full Bit HTTP commands or interrupted-transfer prefix parity.

```sh
node --test scripts/rust-object-import/tar-staging.test.cjs
BIT_LEGACY_ROOT=/tmp/private-compiled-bit \
  node scripts/rust-object-import/tar-http-qualification.cjs \
  /tmp/private-compiled-bit "$PWD/scripts/rust-object-import/tar-batch-worker.cjs"

# Include file staging costs in the Source-only benchmark.
BIT_TAR_QUALIFICATION_STAGE=1 BIT_TEST_OBJECT_IMPORT="$PWD/native/target/release/bit-object-import" \
  node scripts/rust-object-import/tar-intake-benchmark.cjs \
  /tmp/private-compiled-bit /tmp/previous-native-helper \
  "$PWD/scripts/rust-object-import/tar-batch-worker.cjs"

# Include same-worker loopback HTTP and staging; default nine rounds after warm-up.
BIT_TAR_QUALIFICATION_TRANSPORT=http BIT_TEST_OBJECT_IMPORT="$PWD/native/target/release/bit-object-import" \
  node scripts/rust-object-import/tar-intake-benchmark.cjs \
  /tmp/private-compiled-bit /tmp/previous-native-helper \
  "$PWD/scripts/rust-object-import/tar-batch-worker.cjs"
```

`BIT_TAR_QUALIFICATION_DIRECTORY` selects the external object/fixture filesystem; `BIT_TAR_STAGING_DIRECTORY` independently selects the external staged-file filesystem. Reports record both filesystem types, transport, staging mode, and binary/client/adapter/stager fingerprints. Run storage comparisons sequentially and verify all persisted compressed bytes. Raw evidence stays outside Git.

## Staging-inclusive Linux measurements (2026-10-09)

Nine alternating fresh-process rounds after warm-up, sequential storage comparisons, and exact readback of every persisted compressed Source. The control streams the same archive through the actual compiled decoder and previous native batch importer. The candidate additionally spools it to an owned file before using the Rust kernel. Both perform loopback HTTP in the same worker, including its server/client cost in CPU and sampled memory.

| Workload                         | tmpfs HTTP intake ms, control → staged kernel | Btrfs HTTP intake ms, control → staged kernel |
| -------------------------------- | --------------------------------------------- | --------------------------------------------- |
| 4,096 × 1 KiB Sources            | 109.8 → 45.0                                  | 149.9 → 87.7                                  |
| 32 × 8 MiB compressible Sources  | 78.4 → 54.0                                   | 82.8 → 54.7                                   |
| 16 × 1 MiB random binary Sources | 68.2 → 35.8                                   | 63.9 → 36.9                                   |

Intake medians improve 31–59% on tmpfs and 34–42% on Btrfs with transfer and staging included. Startup-inclusive worker elapsed improves 11–25%; whole worker/helper CPU improves 10–29%. Sampled simultaneous process-tree RSS ranges from nearly unchanged to about 20% lower. Inputs and staged files use the reported filesystem. These are Source-only fixture HTTP operations, not production HTTP/full Bit commands, mixed-object imports or JS compressed-buffer control results. Sampling does not establish a universal peak-memory bound.

Raw reports, hashes and logs remain outside Git at `$HOME/bit-object-tar-staging-evidence-2026-10-09`. Candidate helper/client/adapter/stager and worker/loopback fingerprints are recorded when applicable, with end-of-run checks rejecting changes to measured code. Further normal-path integration must still preserve interrupted-transfer prefix semantics and canonical queue/cache/hook/index policy.

A separate nine-round file-input comparison also includes candidate staging on tmpfs: many-small intake 102.0 → 37.3 ms, compressible 76.4 → 47.4 ms, binary 52.6 → 21.9 ms. The control reads the original file directly. Intake improves 38–63%, startup-inclusive worker elapsed 15–26%, CPU 11–28%, sampled RSS 6–19%. This is the same Source-only boundary and does not establish ordinary file-import command gains.
