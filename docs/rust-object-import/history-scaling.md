# Overlapping history scaling

The [shared-history qualification](./shared-history.md) established origin/cache ordering and interrupted-response parity. Two new explicitly selected full CLI HTTP workloads scale histories while retaining local model state. They use the existing merged importer and helper; this chunk changes qualification code only, and tar remains opt-in.

Each workload has one remote, four components and one 1 KiB Source per component. `history-overlap-32` has 32 incoming and 32 local Versions per component; `history-overlap-512` has 512 of each. Incoming Versions form a chain, and local Versions branch from its first Version. Seeds contain no Sources. Fixture construction and canonical seed writes run outside command timing.

The larger fixture exposed a collision in the old fixture's reserved local tag `1.0.90`: it is also a genuine incoming tag once histories grow. Large fixtures now reserve `9.0.90` and orphan `9.0.91`, preserving both incoming and local tags. The original small overlap fixtures retain their existing names and three-Version seeds. Local Version counts are bounded to 3–4,096.

## Readback and persistence boundary

Cold and warm production `bit import --objects --all-history` / repeated objects-only commands verify every Source/Version/model/history, full Source bytes, exact tags/head/state/orphans, history hashes and parents, retained complete-history markers, indexes and persisted origin remote-main refs. Local heads and state survive while remote-main refs record incoming origin heads. Canonical/native whole-model/Version/history digests match across all rounds and separate diagnostic/profile commands.

| Workload            | Verified objects | Entries per merged history | Serialized history bytes | Native mutable writes per cold import |
| ------------------- | ---------------: | -------------------------: | -----------------------: | ------------------------------------: |
| history-overlap-32  |              268 |                         64 |                    8,332 |                                   132 |
| history-overlap-512 |            4,108 |                      1,024 |                  131,694 |                                 2,048 |

The existing native mutable writer accepts serialized objects up to 16 KiB. Small histories therefore accompany 128 incoming Version writes through Rust. Large histories use canonical compression/persistence while all 2,048 incoming Versions still use Rust. Selecting the canonical path because of size is not a failed native write and does not increment mutable fallback counts.

Separate cold diagnostics explicitly require model/history merge-policy coverage, four native Sources, no Node Source hydration, no incoming metadata inflation and no Source fallback. Native submitted/acknowledged mutable counts must equal the table, with zero mutable fallback. Warm commands submit no mutable writes. Expected canonical merged serialization sizes are recorded in the reports and checked against persisted readback, so the size boundary is exercised rather than assumed.

## Existing path measurements and attribution

Nine retained alternating fresh-process rounds per mode follow excluded warm-up on tmpfs and Btrfs. Diagnostic and 1 ms inspector profile commands run separately. The unchanged compiled graph and release helper pass before/after hash guards; retained harness hashes match the source. Linux x64, Node 24.21.0. GNU time includes waited helper CPU; inspector profiles cover only the owning CLI main thread, and the loopback server is outside those CPU measurements.

Cold medians for the existing canonical (`legacy`) and native (`tar`) paths:

| Filesystem | Versions per side/component | Canonical wall ms | Native wall ms | Canonical CPU s | Native CPU s |
| ---------- | --------------------------: | ----------------: | -------------: | --------------: | -----------: |
| tmpfs      |                          32 |             308.1 |          293.5 |            0.40 |         0.38 |
| tmpfs      |                         512 |             628.7 |          494.1 |            0.87 |         0.68 |
| btrfs      |                          32 |             359.3 |          341.0 |            0.47 |         0.44 |
| btrfs      |                         512 |             810.5 |          591.1 |            1.00 |         0.79 |

These compare existing paths on new fixtures; they establish no new kernel speedup. The measured scaling varies incoming object count, tag count, retained history and seed size together, so it does not isolate history cost from Version processing.

Btrfs 512-Version cold wall times vary from 673.6–1,681.5 ms in canonical mode and 536.9–1,634.6 ms in native mode; all rounds remain retained. Treat the medians as local context, without assuming stable per-command gains.

In the tmpfs native 512-Version diagnostic, four history-policy calls sum to 1.55 ms and four model-policy calls sum to 4.49 ms. These are inclusive elapsed durations; asynchronous calls overlap and include awaited work, so they are not additive CPU time. The separate native cold main-thread profile attributes approximately 2.90 ms of self samples to the VersionHistory model module, 0.86 ms to model merge policy and 27.85 ms to the Version model module. Version samples include parsing, constructing, serializing and validating. Module self time includes functions beyond merge and excludes descendants.

One profile/diagnostic pair per workload/mode/filesystem provides attribution, not a precise kernel cost. Short functions can fall between 1 ms samples; zero samples do not prove zero work. On these fixtures history/model merge policy is a weak target for the next native kernel. The next investigation should isolate Version parsing/serialization and per-object dispatch, measuring the complete import boundary before choosing a change.

On Btrfs the native 512-Version diagnostic sums are 1.75 ms for history and 6.38 ms for model policy. Its separate profile attributes approximately 6.99 ms of self samples to the VersionHistory model module and 42.13 ms to Version; model-policy self samples are zero. This corroborates the candidate direction without proving that Version work can be removed safely or profitably.

## Validation and limits

The full local suite passes 216 Node tests with one platform-specific skip. A new large local-overlap repository regression applies canonical merge policy to 128 incoming plus 128 local Versions, verifies that incoming tag 90 and the distinct local/orphan tags survive, and deliberately removes a local history entry to require readback failure. Existing shared origin/cache and interrupted-prefix regressions pass. Full private compiled-CLI fixture regressions run locally; lightweight platform CI retains its existing coverage.

Prettier, Node syntax and diff checks pass. Production/Rust sources, protocols, dependencies, lint rules and default enablement are unchanged. PR #66 merged with all seventeen runnable CI checks passing. The original rust branch and user lockfile remain unchanged.

A canonical/native many-small full CLI HTTP regression passes through the unchanged default fresh-fixture path.

Raw reports, separate profiles, the excluded exploratory 64-Version trial and logs remain outside Git in `$HOME/bit-history-scaling-evidence-2026-10-10`. The unchanged helper SHA-256 is `78d9fc435139d0c740d24ca72e43a936dca9161a5241d1773b215336aeb0df5b`.

```sh
TMPDIR=/tmp \
BIT_IMPORT_QUALIFICATION_TRANSPORT=http \
BIT_IMPORT_QUALIFICATION_MODES=legacy,tar \
BIT_IMPORT_QUALIFICATION_CASES=history-overlap-32,history-overlap-512 \
BIT_IMPORT_QUALIFICATION_ROUNDS=9 \
BIT_IMPORT_QUALIFICATION_TMPDIR=/dev/shm \
BIT_IMPORT_QUALIFICATION_CPU_PROFILE_DIR=/absolute/evidence/profiles \
BIT_IMPORT_QUALIFICATION_REPORT=/absolute/evidence/results.json \
node --expose-gc scripts/rust-object-import/import-qualification.cjs \
  /absolute/compiled-cli /absolute/merged-release-helper
```

Use an external Btrfs scratch directory for disk variation. The six default fresh workloads remain unchanged. These fixtures use one remote and parent-only histories; unrelated/squashed edges, LaneHistory, external cancellation, arbitrary cross-remote interleaving, write-invalidated missing-lookup reuse, sequential batching, trusted provisioning and broader platform/ACL/WAN/checkout/install qualification remain open under #33.
