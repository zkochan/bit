# Shared origin/cache HTTP histories and interrupted responses

The seeded overlap checks in [local-overlap.md](./local-overlap.md) used disjoint identities across remotes. `shared-http.cjs` now qualifies four components whose origin and cache share Source, Version, ModelComponent and VersionHistory identities. The origin has eight Versions; the cache has the first two plus a distinct branch Version. Each destination starts with local model state, three additional local Versions and overlapping history.

The driver calls the production `ObjectFetcher`, `Remote`/`Http` and server `FetchRoute` from the same compiled graph used by the command benchmarks. Its existing grouped-ID argument explicitly routes each component to both remotes. This is functional pipeline qualification, outside CLI timing; it does not qualify CLI discovery of shared dependencies or establish a performance improvement. Runtime and Rust code are unchanged, and tar remains opt-in.

## Authority differs from history deduplication

Both requests run concurrently. Before starting the second response, the server waits until every first-response Source and Version is readable from its compressed destination file and each history contains a response-specific marker. The marker is absent from the local seed. This controls arrival through actual persistence, rather than a delay intended to approximate processing time. Waiting is bounded to ten seconds; worker execution is bounded to thirty seconds.

Successful canonical and native imports agree in both orders:

- Origin models take precedence over cache models, including when the cache arrives first. Local tags/state/head remain intact, origin tags are added, and persisted remote-main refs record the origin head. The cache-only tag is absent from the resulting model.
- The shared write queue reserves each history identity only once. Origin-first yields eight origin entries plus three local entries. Cache-first yields two shared entries, the cache branch entry and three local entries. Later history content is skipped even though later Version objects are stored.
- Both paths return unique added hashes and verify all sixty expected objects, full Source bytes, tags/heads/state/orphans, exact history hashes and parents, retained complete-history markers, component indexes and persisted remote refs. Whole-model/history/Version digests match between modes for each order and differ between the two orders.

This arrival dependence is existing canonical behavior, not an authority rule added by this chunk. Any future batching or merge change must explicitly account for it. Four history-policy calls per run demonstrate that the second history is skipped; successful imports also execute four model-policy calls. Native diagnostics report four native Sources and forty acknowledged mutable writes, with zero mutable fallback or incoming metadata inflation.

## Interrupted second response

After the same persistence gate, the second server response sends a valid `.BIT.START` tar entry and then closes the connection before completing the archive. The first response uses the actual FetchRoute; only the deliberately interrupted response is synthesized for fault injection. Both canonical and native fetches reject with exit code 1.

Readback verifies the complete first-response prefix and all seed objects. Existing model tags/state/head/orphans/indexes remain intact, and no remote-main ref is committed. Histories retain their first-response merge and all local entries. No model merge policy runs after the transport error.

| First response | Verified objects per mode | Native Sources | Acknowledged native mutable writes |
| -------------- | ------------------------: | -------------: | ---------------------------------: |
| Origin         |                        56 |              4 |                                 36 |
| Cache          |                        36 |              4 |                                 16 |

Submitted native mutable counts equal acknowledged counts, with zero mutable fallback and incoming metadata inflation. Full persisted-model digests match canonical failure behavior. This qualifies a broken second HTTP response after a persisted first response; external process cancellation and arbitrary interleaving during an unfinished first response remain open.

## Validation and reproduction

All eight scenarios (success/interruption × origin/cache first × canonical/native) pass on tmpfs and Btrfs. Helper and compiled-module hashes are checked before and after execution, and reports record harness hashes and isolated globals. Temporary scopes and loopback servers are cleaned up. The unchanged helper SHA-256 is `78d9fc435139d0c740d24ca72e43a936dca9161a5241d1773b215336aeb0df5b`.

The full local suite passes 215 Node tests with one platform-specific skip. The new regression executes all eight scenarios using the checksum-verified packaged helper and full private compiled CLI. It requires Linux, `BIT_LEGACY_ROOT` and `BIT_TEST_OBJECT_ARTIFACT`; lightweight platform CI retains its existing coverage. The unchanged default HTTP fixture path also passes a canonical/native many-small CLI regression. Prettier, Node syntax and diff checks pass. Native sources and dependencies are unchanged; PR #65 merged with all seventeen runnable checks passing.

Raw reports and logs remain outside Git in `$HOME/bit-shared-history-evidence-2026-10-10`.

```sh
TMPDIR=/tmp \
BIT_IMPORT_QUALIFICATION_TMPDIR=/dev/shm \
node scripts/rust-object-import/shared-http.cjs \
  /absolute/compiled-cli /absolute/merged-release-helper \
  /absolute/evidence/shared-tmpfs.json
```

Use an external Btrfs scratch directory for the second filesystem. The compiled CLI must contain `.bit-object-import-build.json` from the existing qualification build workflow.

Next: scale overlapping histories and profile their CPU before selecting a bounded native kernel. External cancellation, LaneHistory, write-invalidated missing-lookup reuse, sequential batching, trusted provisioning and broader platform/ACL/WAN/checkout/install qualification remain open.
