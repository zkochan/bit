# Client main and lane merge transactions

Main and lane merges use an owned Rust repository session when
`BIT_RUST_CLIENT_VCS=on`. The default remains the canonical TypeScript path.
Rust selects merge status, apply decisions, result membership and dependency
policy, and retains verified Source bodies for three-way merging and file writes.

## Ownership and public effects

An outer operation acquires one physical helper. Nested lane, status and apply
journals retain independent revisions and close in reverse ownership order.
Protocol requests are serialized while the original public callbacks retain
their concurrency. A lost or invalid receipt retires the session; the adapter
continues with the callbacks, objects and clone prefix already observed.
Completed callbacks and effects are never replayed to obtain another receipt.

Status discovery remains serial. The existing gap import runs once before
concurrent per-component merge plans. Apply remains serial, followed by the
existing writer, configuration, persistence, pending state, bitmap, installation
and auto-snap boundaries. Receipts record those boundaries after their effects.
This is not an encompassing atomic transaction or rollback mechanism.

Public prompts, imports, model and Source class hydration, configuration hooks,
installation, build, removal effects and CLI formatting remain adapters. Native
dependency selectors consume the identities and existence results returned by
the original callbacks. Hidden lane updateDependents remain in lane history
while result selection excludes them from visible workspace writes.

## Retained file bodies

The status owner prepares verified incoming, base and current contents in a
private directory. Workspace inputs retain filesystem provenance; model inputs
retain Source object provenance. Private receipts carry compressed Source
objects for the existing repository cache and public Source class hydration.
Their decoded contents are not sent back as protocol input.

Logical Source loads and file construction preserve their original group and
completion order. The adapter retains those observations for a fallback suffix.
The synchronous label prefix still hashes and classifies current LF contents in
Node so label writes precede the original Source-load awaits. Rust performs its
own verified classification afterward; both costs belong in measurements.
Rust receives completion permutations and selects the final row order. Late
apply retargets the retained plan to the Version loaded by the original public
loader, including additional Sources absent from the initial incoming plan.

File selectors carry explicit Buffer alias provenance. Unchanged target clones,
current files and incoming cached Sources preserve their respective aliases;
merged text creates a fresh Buffer. Equal bytes alone do not establish an alias.
The adapter validates the entire batch before attaching retained contents, and
the existing workspace writer writes those bodies directly from the helper.
Actual decoder-read and completed-write counters are distinct from receipt
acceptance and retained-body counts.

Private body files outlive child journal closure until workspace-engine cleanup.
Escaped public merge results hydrate their own output strings before directory
removal. Replaced public getters are never invoked by that cleanup.

## Compatibility boundaries

Default constructors, defining functions, own data descriptors, original object
aliases and immutable Buffer observations are checked before native results are
used and again after asynchronous acknowledgements. Custom getters, proxies,
changed intrinsics, stale metadata or unsupported bounds decline to the
canonical suffix. The public file clone prefix runs once even when native apply
declines. A partially attached native batch cannot trigger canonical replay.

The history graph reader accepts validated builder artifact metadata without
reading artifact Sources or changing graph traversal and ordering. Other
repository readers retain their existing validation policy.

Fast-forward merges do not create a three-way retained body plan. Their
operation selectors and existing writer path are checked separately from the
retained merge-body path.

Qualification and complete-command performance results are pending the final
production freeze. Preliminary builds and fixtures are not release evidence.
