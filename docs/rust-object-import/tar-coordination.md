# Repository coordination for staged tar batches

`ObjectsWritable.prepareTarBatch()` connects transport-validated descriptors to the existing repository policy. It is an internal interface for the next transport integration; ordinary HTTP imports do not call it yet.

The caller supplies at most sixteen ordered descriptors and a lazy compressed-body loader. A `sourceHash` may only come from the Rust kernel's validated `source` outcome for that exact descriptor in an owned, immutable archive. Markers remain the transport's responsibility. The caller must use the repository's current native store directory and ownership options, keep the archive open through settlement, and await the complete native operation as well as the shared write queue.

Eligible Sources reserve their hash in the existing operation-wide `WriteObjectsQueue`, including deduplication across remote writers. Their compressed bodies remain in Rust. Other objects load from staged ranges and follow the existing JavaScript parsing, component collection and mutable merge policy in descriptor order. Native writes require the existing Unix, transform, hook and repository-method guards; eligibility is checked again after metadata policy runs. Changed policy downgrades reserved Sources to canonical writes.

The returned decision contains selected indices, a possible ordered policy error, and a single-use settlement callback. The transport commits the selected Source prefix before reporting a later policy error. On acknowledgement, settlement invalidates both repository cache layers without loading successful Source bodies. Failed or uncertain writes load and validate only the unacknowledged reserved Sources and repair them through `Repository.writeObjectsToTheFS()`. Repair verifies Source type and hash. Metadata merges are never repeated by settlement.

The experimental tar client now invokes settlement after validating acknowledgements. With partial, missing or malformed acknowledgements, it reaps the helper before repair so late native writes cannot race canonical writes. A repaired partial batch still reports the native failure; this does not provide recovery of the archive's unprocessed suffix. Full replay after repository policy has begun remains unsafe without a processed-descriptor cursor.

Repository callers use `awaitSelection: true` and cooperate with the selection `AbortSignal`. Cancellation waits for in-flight policy to finish, reaps the helper, invalidates possible native writes, and disables additional Source repairs. Already-started canonical writes can finish; cancellation does not roll them back. Generic qualification callbacks may retain the default bounded timeout behavior, but callbacks with repository side effects must use the cooperative contract.

## Validation

```sh
BIT_LEGACY_ROOT=/tmp/private-compiled-bit \
  node --test scripts/rust-object-import/tar-coordination.test.cjs
node --test scripts/rust-object-import/tar-batches.test.cjs
```

Nine actual compiled repository tests cover shared reservations, uncertain and partial writes, cache invalidation, custom persistence hooks, metadata ordering, changed policy, cancellation and a mixed Source/VersionHistory archive processed by the real Rust helper. The mixed test loads only the metadata body into Node. The native mixed test skips when no helper is present; the remaining repository tests run after compilation in the first GitHub Actions E2E shard. Four additional portable protocol tests run in the existing native platform matrix.

Local validation: all nine repository tests passed; the portable helper suite passed 93 tests with one Windows-only skip; the compiled object suite passed 106 tests with one pending test; canonical `npm run lint` passed in a physically isolated CLI. No new Rust code, lint exemptions, dependencies or benchmark claims are introduced. Reports and temporary archives remain outside Git.

Remaining work is the production transport adapter: marker policy, owned staging and lazy range reads, safe continuation after native failure, and ObjectFetcher integration. Command-level compatibility and performance qualification must follow before enabling this path for ordinary imports.
