# Repository and checkout qualification

The reference is the published Bit 2.2.94 CLI. This milestone joins repository reads,
selection, current-source capture, materialization and local publication for checkout,
revert, lane switching and selected reset batches. Rust owns operation state and the
source data path. Published Harmony providers, component hydration and extension
callbacks remain adapters; source contents use private file spools.

## Operation coverage

Checkout and revert support exact, glob, list, negation, state and AND selectors.
State selection keeps the authoritative capture and its complete read proofs rather
than loading selected components a second time. Short snapshot refs resolve against
stored objects and the import overlay, including ambiguity caused by non-Version
objects. The candidate list is validated again before publication.

Stored tags, snaps, ancestor refs, main and lane heads use the same validated
repository reads. Local-only repository paths retain their local-history behavior;
mapped remotes retain canonical refresh ordering. File materialization preserves
binary bytes and platform line-ending behavior, removes obsolete sources and restores
missing directories during checkout reset. Revert retains the current bitmap version.
Manual, ours and theirs strategies preserve the reference conflict reports and files;
an unresolved conflict reports the canonical error without replaying providers.

Workspace-root components keep full Version proofs, including protected entries,
while the write plan excludes the live bitmap and nested component directories.
The current bitmap and nested versions survive root checkout. Repository metadata and
bitmap history follow the real scope location, including `.git/bit`; checkout does not
create a shadow `.bit` repository.

Existing `component.json` files are rewritten natively with the target component version,
`propagate: false` and configured extension identities, matching the published writer.
The callback benchmark verifies the complete configuration bytes as well as sources.

Workspace dependency-policy updates and conflicts are planned in Rust and published
after component files and bitmap. The shared comment-json-compatible JSONC writer
preserves interior, block, property and document-tail comments. Installation retains
its existing `bit_install::jsonc` API through a re-export of that shared implementation.
Existing-file publication validates identity, link count and reparse/symlink behavior
before writing, including on Windows.

`checkout head --include-new-from-scope` discovers configured default-scope components,
fetches their objects, selects collision-checked destinations and adds their sources
and bitmap rows. Scope LICENSE contents come from the component's scope metadata;
an unrelated local scope's license does not change the component. Generated LICENSE
files remain outside tracked Version files and checkout file-change reports.

Reset freezes selected batches for glob and state predicates, including pending-deleted
rows. Explicit dependent checks retain Node's original graph semantics; `--force`
controls that check. Main and lane batches publish once and revalidate the selection
before commit. Soft reset consumes the selected pending bitmap tags.

## Lifecycle and safety

Provider startup precedes the authoritative command controls. Native eligibility is
checked before permitted provider effects. Once a provider, dependency-cache prefix
or publication has begun, failures belong to this invocation and never run the
command a second time through fallback. Callback fixtures use physically compiled
aspects and compare output order, source changes and callback side-effect counts.

Corrupt target Sources are exercised before any file/bitmap publication. Proofs cover
configuration, source contents, repository inputs, short-ref candidates and destinations.
Windows fixtures cover real checkout/revert/reset/switch operations, CRLF and
binary contents, scope metadata, root protection and conflict strategies.

## Retained boundaries

Interactive merge prompting, unsupported option syntax and package managers remain
canonical boundaries. Complex checkout ancestry involving squashed/unrelated histories
and removed target Versions retain their existing checkout guards. Broader history and
removal work remains tracked in the merge/history milestone. Direct HTTP transfers that
need an object overlay retain their transport boundary; configured file-remote scope
addition is covered here, while fetch/push orchestration remains a separate milestone.
Missing/corrupt inputs and over-budget or unsafe receipts guard publication. Inputs
that fail native eligibility before effects delegate; errors after permitted effects
remain owned by the native command.

The pending-deleted reset oracle also characterized an existing native `list` display
difference (`currentVersion` versus `N/A`). Reset writes and canonical repository reads
match Node; the separate list presentation discrepancy is not hidden by this milestone.

## Qualification record

All seven local gates passed: formatting, warnings-denied Clippy and Dylint, rustdoc,
workspace tests (1,212 passed, one existing ignored), the complete end-to-end suite
(406 passed), and port-inventory validation. The warnings-denied release build passed.
Exact-head Linux and Windows CI remains pending; this local record does not qualify
platform CI or authorize checking off the milestone before those checks pass.

Five alternating fresh-copy Node/Rust pairs per workload measured complete command
processes on Linux with Node 22.22.0 and published Bit 2.2.94. Twenty timed pairs and
twenty additional real TTY pairs matched exit status, stdout/stderr and exact bitmap,
workspace source/configuration files and symlinks. Repository caches, Git data and
`node_modules` are excluded from this filesystem comparison. Only Rust trace lines
and elapsed durations inside completed-in status messages are normalized; ANSI colors
are preserved. TTY runs use `script -q -e`, `TERM=dumb`, `FORCE_COLOR=1`, with CI unset.

| Workload | Node median | Rust release median | Node/Rust |
| --- | ---: | ---: | ---: |
| Stored checkout | 474.951 ms | 23.200 ms | 20.5× |
| Checkout reset | 471.321 ms | 23.211 ms | 20.3× |
| Revert | 471.338 ms | 9.144 ms | 51.5× |
| Checkout with compiled callbacks | 548.837 ms | 508.649 ms | 1.08× |

These are local complete-command measurements, including Harmony startup where needed.
[The benchmark record](../../scripts/rust/benchmarks/checkout.json) contains all samples,
fixture creation commands and fingerprints, helper/release hashes, frozen native-source
identity and raw verification paths. The callback workload is faster by about 7%; its
smaller margin should not be generalized to other machines or workloads.
