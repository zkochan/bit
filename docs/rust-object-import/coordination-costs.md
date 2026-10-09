# Native store eligibility coordination

The progressive HTTP path from [PR #59](https://github.com/zkochan/bit/pull/59) still queried native store options before metadata hydration, mutable persistence and Source commit. A diagnostic mutable-heavy import made 8,155 options queries and 8,157 ownership queries, despite having no group ownership configured. Each default query allocated an options object, resolved its path and awaited an async ownership method that immediately returned `null`. The tar adapter additionally awaited an async eligibility wrapper.

`Repository.getNativeSourceStoreEligibility()` now returns a synchronous boolean for the default store without group ownership. It checks the same live platform, persist/read hook and transformer policy on every call. It returns `undefined` when group ownership or an overridden options, ownership or path method requires the original async API. The options API retains its existing signature and ownership/error behavior. There is no cached eligibility or ownership decision.

The tar adapter and mutable writer await only asynchronous decisions. Metadata still rechecks eligibility after earlier merge policy, and reserved Sources recheck before commit. Custom persistence/index methods retain the existing canonical guard. Object formats, Rust protocols, helper sources, network policy, merges and indexes are unchanged. The tar path remains opt-in.

Four compiled repository regressions cover synchronous live hook changes, repeated group ownership lookup, custom options changing between reservation and commit, and original ownership/path error identity. Existing metadata hook transitions, partial acknowledgement, canonical repair, cancellation, HTTP continuation and packaged-helper tests remain applicable. The genuine private CLI compilation, canonical `npm run lint` and all 200 applicable Node tests pass, with one platform-specific skip. All 60 Rust workspace tests also pass; Rust sources, dependencies and inherited pnpm lint rules are unchanged.

## Genuine command comparison

The command driver accepts `tar-baseline` with `BIT_IMPORT_QUALIFICATION_BASELINE_CLI` to compare separate compiled snapshots using the same progressive production transport and helper. Both snapshots' compiled module hashes are verified before and after the run and their provenance is retained. Fixtures, server, workspace initialization and readback use the candidate snapshot for both modes; only the measured import command selects the baseline CLI. Every command verifies identical Source bytes and canonical models, versions/tags/heads and indexes. Diagnostics also require full native Source coverage, zero fallback, zero Source hydration and zero incoming metadata inflation for both modes.

Nine retained alternating fresh-process rounds per snapshot after warm-up, Linux x64, Node 24.21.0. Cold command median milliseconds:

| Filesystem | Workload           | Merged PR #59 | Synchronous eligibility |
| ---------- | ------------------ | ------------: | ----------------------: |
| tmpfs      | many-small         |         413.3 |                   408.1 |
| tmpfs      | large-compressible |         341.8 |                   338.0 |
| tmpfs      | large-binary       |         407.5 |                   391.8 |
| tmpfs      | mutable-heavy      |         762.8 |                   756.1 |
| tmpfs      | multi-remote       |         313.8 |                   310.8 |
| btrfs      | many-small         |         427.7 |                   419.2 |
| btrfs      | large-compressible |         343.3 |                   338.0 |
| btrfs      | large-binary       |         350.9 |                   342.3 |
| btrfs      | mutable-heavy      |         824.8 |                   809.1 |
| btrfs      | multi-remote       |         312.0 |                   304.9 |

Median cold differences across these fixtures are roughly 1–4%, with overlapping observed distributions; they do not establish a broad command speedup. Mutable-heavy interquartile ranges are 749–1038 ms baseline versus 736–803 ms candidate on tmpfs, and 809–849 versus 793–834 ms on Btrfs. Repeated imports show no consistent gain.

The structural coordination reduction is clearer. Mutable-heavy async store-options queries fall from 8,155 to 2 and ownership queries from 8,157 to 4 on both filesystems. The remaining queries configure helpers and repository writes. Live synchronous eligibility runs 8,153 times instead of caching policy. Tmpfs Promise creations/callbacks fall from 255,391 / 155,136 to 191,346 / 114,687 (25% / 26%); Btrfs falls from 253,399 / 153,989 to 195,750 / 117,024 (23% / 24%). Many-small tmpfs callbacks fall from 23,602 to 18,904 (20%). Asynchronous resource counts include all command work and vary with filesystem scheduling.

Mutable-heavy median total CPU seconds / sampled RSS MiB are 1.16 / 249.1 baseline versus 1.15 / 247.7 candidate on tmpfs, and 1.24 / 239.9 versus 1.21 / 237.8 on Btrfs. No substantial CPU or memory reduction is established. All five workloads on both filesystems pass full cold/warm readback and diagnostic coverage checks.

Raw reports, exact snapshot/helper provenance and logs remain outside Git in `$HOME/bit-coordination-evidence-2026-10-09`. The unchanged helper SHA-256 is `71cede471917682eb3597fcd3bd0ba3bcc89e3f4f5e7cdabd944feb41423a07b`. Native merge/index kernels, trusted automatic provisioning and broader platform/ACL/WAN/checkout/install qualification remain open. Next, profile mutable write request/acknowledgement boundaries and canonical merge/index work before selecting another batching or native kernel change.

Reproduce on Linux with a compiled merged-PR #59 baseline and a separately prepared candidate:

```sh
TMPDIR=/tmp \
BIT_IMPORT_QUALIFICATION_TRANSPORT=http \
BIT_IMPORT_QUALIFICATION_BASELINE_CLI=/absolute/compiled-pr59 \
BIT_IMPORT_QUALIFICATION_MODES=tar-baseline,tar \
BIT_IMPORT_QUALIFICATION_ROUNDS=9 \
BIT_IMPORT_QUALIFICATION_TMPDIR=/dev/shm \
BIT_IMPORT_QUALIFICATION_REPORT=/absolute/evidence/results.json \
node --expose-gc scripts/rust-object-import/import-qualification.cjs \
  /absolute/compiled-candidate /absolute/release/bit-object-import
```

Use a disk directory outside Git instead of `/dev/shm` for the Btrfs comparison. Timed commands exclude diagnostic instrumentation; nested diagnostic stage times are not additive. GNU time includes waited helper CPU; simultaneous process-tree RSS uses 10 ms sampling and excludes server memory, filesystem cache and staged bytes. These are local objects-only HTTP commands, not WAN or checkout/install qualification.
