# Isolated install acceptance gate

`install-validation.cjs` runs the real Bit CLI in a Linux network namespace. Its package-manager observer delegates to the original `@pnpm/napi` installer; it does not implement a fake successful install. The helper remains explicitly opt-in. Correctness and native participation must pass before this lane can support install timing claims.

```sh
node scripts/rust-dependency-analysis/install-validation.cjs \
  /tmp/bit-rust-cli-source \
  /absolute/path/bit-dependency-scanner \
  /tmp/install-validation-result.json \
  --legacy-umbrella /existing/bvm/node_modules/@teambit/legacy
```

The CLI input must be a private build with `.bit-rust-private-build.json`; compiled module hashes are checked. The driver copies the complete installed snapshot into an owned temporary baseline, then gives each variant a fresh physical/reflink copy at the same absolute workspace path. Absolute internal symlinks are rerouted; dangling internal aliases are preserved, dangling external aliases pruned, and live external aliases rejected. The optional existing legacy umbrella package is fully copied into this baseline, with separate source-path/version/member-hash provenance. The driver never installs in the supplied snapshot, BVM tree, or user checkout.

Each real command runs in `unshare -Urn`, so it and descendants have no external network interface. Unsupported hosts fail the gate. The command is `install --lockfile-only --skip-import --skip-compile --skip-write-config-files`. An empty dependency cacache is asserted before each variant. An identical comment is appended to the owned `generate-tree-madge.ts` source to attempt invalidating model dependency reuse without changing imports or installed package requirements. This does not assume extraction occurred: the observer separately counts actual `generateTree` calls, helper starts/requests/outcomes, and package-manager calls.

Private store/cache paths and disabled global virtual store are requested in `pnpm-workspace.yaml`, `.npmrc`, and environment configuration. Before forwarding an observed install call, the observer refuses store/cache paths outside the private workspace. Registry credentials and proxy configuration are excluded from that trace. The native config reader honors the YAML camel-case settings; a direct config-only experiment found that the `.npmrc` and environment store overrides did not change its defaults.

Acceptance requires both real commands to succeed, native helper requests with successful outcomes, real lockfile-only installer calls, exact dependency-cache records and project inputs, and matching resulting lockfile bytes. Empty observations cannot pass. Commands have two-minute timeouts and bounded output. Owned copies are removed after completion. Reports contain dependency/project data and bounded failure output; keep them private when workspace data is sensitive. The script produces no install timing or speedup result.

## Current result

The October 7, 2026 Linux/x64 probe used Node 24.21.0, the trusted CLI built from `b262e69d4`, and helper SHA-256 `23525b6a895a6e566c4273d73bbfd9a3d5492daf2b1107ae09eb9745c5e797d0`. Initial probes failed during linking because the snapshot's external `@teambit/legacy` alias was absent inside the private tree. Read-only inspection found an existing BVM-installed package, version 2.1.0, whose `dist/api.js` contains only `"use strict";`; the linker uses `require.resolve` to locate its directory. Materializing that existing package fixed linking. It was not produced by the 334-component private build.

An intermediate probe reached the original installer wrapper, which correctly refused the shared default store before invoking installation. The final probe supplied supported private YAML settings and reached the CLI's package-installation phase. Both variants then failed trying to fetch React metadata from `node-registry.bit.cloud`: the kernel rejected the connection with `Network is unreachable` (error 101). The network namespace prevented the download. The trace recorded no original installer calls, so forwarding and actual install-path store isolation are not established by that final result; config-only confirmation is separate evidence.

Both final runs passed the initial empty-cache assertion and populated 334 dependency-cache records, but recorded zero `generateTree` calls and zero helper starts/requests. These records do not prove native extraction or parity. Source inspection shows installation loads components with `loadSeedersAsAspects: false` to avoid loading environments before packages exist; this is relevant context, not a proven explanation for the zero extraction calls. A comment-only source change did not produce observed scanning in this workload.

Install acceptance remains open. There is no successful no-network install, no verified native install participation, no exact accepted dependency parity, and no install benchmark. Follow-up needs a genuinely analysis-bearing install workload and a self-contained package metadata/lockfile baseline that succeeds under network denial. Existing helper and command benchmark results do not fill this gap. A compact observed result is recorded in [dependency-install-validation-results.json](dependency-install-validation-results.json).
