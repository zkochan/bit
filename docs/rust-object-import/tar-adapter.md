# Staged tar repository adapter

This records the preceding coordination/adapter step. Current opt-in HTTP integration is documented in [http-tar.md](./http-tar.md).

`importStagedTar()` is now an internal TypeScript operation in the legacy scope component. It imports an owned, immutable archive through the Rust tar kernel and `ObjectsWritable`, including ordered marker policy and canonical continuation. Normal HTTP/ObjectFetcher imports do not call it yet; production stream staging and the transport handoff remain the next integration step.

The operation lazily loads only canonical object bodies from archive ranges. Validated eligible Sources remain in Rust, share the existing import queue and are settled through the repository coordinator. It handles START/END JSON, the schema-1 termination rule, ERROR messages, and the existing transport Ref interpretation. Remote framing/marker errors use `TarRemoteError`, retaining the original message for future ObjectFetcher attribution. Repository parse/merge/persistence failures remain writable errors.

After a helper/protocol failure, the client reaps the helper and repairs unacknowledged reserved Sources before the adapter continues. `prepareTarBatch()` now reports its completed descriptor count. The adapter counts completed object policy, decodes the same archive with the canonical decoder, skips those objects, and writes only the suffix. It neither refetches the transport nor repeats completed metadata merges. This fallback rereads compressed prefix bodies into Node; the successful native path avoids those buffers.

A metadata policy failure or failed canonical repair is terminal. A valid Source prefix can commit before a later marker or writable error, matching the writer's ordered-prefix behavior. Caller cancellation and the client's deadline are terminal, wait for cooperative in-flight policy, and suppress additional Source repairs. Already-started canonical metadata writes may finish; cancellation does not roll them back. The deadline does not forcibly interrupt arbitrary JavaScript hooks.

The caller must retain the archive through the complete operation, provide current repository store/ownership options and a trusted helper, and manage the writer lifetime and shared queue. This interface consumes a successfully owned archive; it does not replace the pre-policy lossless staging/replay contract for original HTTP transfers. The runtime binding now includes both new modules. Qualification tools import the production protocol client instead of maintaining a second implementation.

## Validation

```sh
BIT_LEGACY_ROOT=/tmp/private-compiled-bit \
  node --test scripts/rust-object-import/tar-adapter.test.cjs \
    scripts/rust-object-import/tar-coordination.test.cjs
```

Eleven adapter tests and nine coordinator tests pass against the isolated compiled repository. Coverage includes mixed Source/VersionHistory input through the real helper, missing-helper canonical fallback, a real child that writes a Source then exits without acknowledgement, single metadata merge on suffix continuation, remote termination/ERROR/Ref messages, authoritative writable failure, native deadline and cooperative cancellation. Tests requiring a native helper skip if it is absent. The repository suites run after compilation in E2E shard 0; the production client also runs through the existing cross-platform portable protocol tests and strict coordinator type check.

Local validation additionally passes 93 portable helper tests with one Windows-only skip, all 23 release-artifact/discovery tests, 106 compiled object tests with one pending, canonical `npm run lint`, formatting and diff checks. No Rust code/rules changed, no generated evidence is committed, and no new performance result is claimed.

Next: port owned stream staging/replay into the production component, connect a deferred raw-tar transport handoff to ObjectFetcher, and qualify original HTTP failures, mixed-object imports and complete commands against the JavaScript control before enabling this path.
