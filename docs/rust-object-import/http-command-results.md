# Genuine HTTP import qualification

Staged Rust tar intake improves four fixtures relative to the JavaScript compressed-buffer control, but regresses mutable-heavy imports on both filesystems. Keep it opt-in. Its incremental benefit over the previous native path is strongest with two concurrent remotes; metadata processing is the next Rust target.

## Method

These are actual compiled production `bit import <ids> --objects --skip-dependency-installation --json --safe-mode` commands against genuine fixture scopes through the production HTTP FetchRoute, HTTP client and ObjectFetcher. Cold imports use a fresh destination and `--all-history`; warm imports repeat in the same destination. They measure objects-only imports, including CLI startup, merges and indexes, without checkout or dependency installation. The loopback server stays JavaScript in every mode.

Each fixture uses one warm-up and nine retained rounds, rotating control/native/tar order. Diagnostics run separately from timings. Linux x64, Node 24.21.0, compiled Bit 2.2.93, production integration from merged PR #55. Both runs use the same release helper and compiled modules. The tmpfs run stages and stores under /tmp; the Btrfs run sets TMPDIR to its Btrfs scratch directory, placing staging, scopes and destinations there. Cold destination does not imply cold OS or server caches.

| Fixture                | Components | Sources | Total objects | Source bytes |
| ---------------------- | ---------: | ------: | ------------: | -----------: |
| Many small             |        100 |   2,500 |         2,900 |     2.44 MiB |
| Large compressible     |         16 |      32 |            96 |      256 MiB |
| Large binary           |         16 |      32 |            96 |    64.00 MiB |
| Mutable heavy          |        400 |     400 |         4,400 |     0.39 MiB |
| Two concurrent remotes |         16 |      32 |            96 |      256 MiB |

Fixtures have two versions except mutable-heavy, which has eight. Transport export metadata adds an entry beyond the fixture object count.

## Cold command elapsed time

Median milliseconds; JS is the compressed-buffer control, native is the previous native object path, tar enables staged intake in addition to those same native stages.

| tmpfs                  |        JS |  Native |       Tar |
| ---------------------- | --------: | ------: | --------: |
| Many small             |   575.346 | 440.486 |   458.923 |
| Large compressible     |   537.370 | 337.270 |   337.429 |
| Large binary           |   404.384 | 368.742 |   364.114 |
| Mutable heavy          | 1,037.847 | 833.667 | 1,224.807 |
| Two concurrent remotes |   477.967 | 339.439 |   306.569 |

| Btrfs                  |        JS |  Native |       Tar |
| ---------------------- | --------: | ------: | --------: |
| Many small             |   634.355 | 487.991 |   501.902 |
| Large compressible     |   547.330 | 347.518 |   341.362 |
| Large binary           |   405.799 | 366.094 |   365.614 |
| Mutable heavy          | 1,124.680 | 866.074 | 1,280.262 |
| Two concurrent remotes |   493.257 | 345.176 |   317.141 |

Tar is approximately 10–37% faster than JS on four fixtures. Mutable-heavy is 18.0% slower on tmpfs and 13.8% slower on Btrfs; it is 46.9–47.8% slower than native. Relative to native, tar improves concurrent remotes by 8.1–9.7%, regresses many-small by 2.9–4.2%, and changes the other two cases by at most 1.8%. Small differences do not establish a reliable improvement. On tmpfs the mutable-heavy median absolute deviations are 2.0 ms (JS), 34.9 ms (native), and 49.0 ms (tar), well below the regression.

Warm commands correctly persist zero native Sources and show no material speedup. For example, Btrfs mutable-heavy medians are 436.978/445.200/438.480 ms, and concurrent remotes are 263.500/269.156/266.808 ms (JS/native/tar).

## CPU, memory and callback attribution

GNU time records client user plus system CPU, including waited helper children; server CPU is excluded. Sampled process-tree RSS includes the CLI and helpers, sampled every 10 ms. It excludes server RSS, filesystem page cache and staging bytes, and is not machine-wide peak memory.

On Btrfs, large-compressible cold CPU medians are 0.81/0.53/0.50 seconds and sampled RSS medians 231.8/156.6/156.9 MiB. Binary RSS is 287.9/296.8/256.9 MiB. Mutable-heavy CPU is 1.55/1.26/1.43 seconds and RSS 298.1/294.8/285.2 MiB. CPU resolution is 0.01 seconds. Gains relative to JS include earlier native stages; only tar versus native isolates staged intake.

Separate tmpfs diagnostics count filesystem callbacks (FSREQCALLBACK plus FSREQPROMISE):

| Fixture                |     JS | Native |    Tar |
| ---------------------- | -----: | -----: | -----: |
| Many small             | 16,217 |  1,388 |  2,070 |
| Large compressible     |  1,085 |    482 |    564 |
| Large binary           |  1,071 |    496 |  1,574 |
| Mutable heavy          | 29,197 |  8,688 | 15,841 |
| Two concurrent remotes |  1,096 |    497 |    592 |

Tar avoids Node Source hydration and per-Source Node atomic writes. It still stages the response with Node callbacks, reads metadata ranges and inflates metadata in Node. For many-small, zlib callbacks increase from 202 with native to 1,004 with tar; metadata parsing also returns to Node. Binary staging can exceed even the JS filesystem callback count. Fewer Source callbacks alone do not guarantee a faster command.

## Correctness and reproduction

Every cold, warm and diagnostic command verifies all Source lengths, SHA-256 contents and identities, object types, canonical model data, versions, tags, heads and component indexes. Cross-mode model digests match. Tar diagnostics require the expected native Source count, protocol batches, actual component merges, zero Source hydration and zero native fallbacks. Both concurrent remote operations are observed. Compiled module, helper and harness fingerprints are recorded, and compiled modules/helper are checked unchanged at completion.

The trace tests preserve result and error identity and distinguish native success from fallback. Diagnostic instrumentation is absent from measured commands.

Using a separately compiled CLI containing this integration:

```sh
BIT_IMPORT_QUALIFICATION_TRANSPORT=http \
BIT_IMPORT_QUALIFICATION_MODES=control,native,tar \
BIT_IMPORT_QUALIFICATION_ROUNDS=9 \
BIT_IMPORT_QUALIFICATION_REPORT="$HOME/bit-http-results.json" \
node scripts/rust-object-import/import-qualification.cjs \
  /absolute/private-compiled-bit /absolute/bit-object-import
```

For disk qualification set TMPDIR to an existing scratch directory on that filesystem. Reports, scratch scopes and logs stay outside Git. Local raw evidence: `$HOME/bit-object-http-command-evidence-2026-10-09/{tmpfs,btrfs}.json`. Helper SHA-256: `4b8166d1fbfcd098d132962e636839d29daa0afbb8a65f2ba3124a3060c5c12c`; driver SHA-256: `3229aa3a2c60aa51759c31e103cc951474e40a8cf7f1d4156854860998430bba`. This document commits only compact results, not generated evidence.

## Next work

Extend the tar protocol to return bounded metadata inflated by Rust, reusing native metadata validation while retaining canonical JavaScript hydration, merge decisions and error fallback. This should remove the repeated metadata range reads and Node zlib callbacks exposed here. Then assess reducing staging callbacks and operation boundaries. Re-run this three-mode qualification before considering default enablement. Native merge/index transactions, trusted release provisioning and broader platform/ACL, real-network and checkout/install qualification remain open.

The bounded native metadata follow-up and four-mode results are recorded in [tar-metadata.md](./tar-metadata.md). It removes the regression against JavaScript while retaining a mutable-heavy gap to the previous native path.
