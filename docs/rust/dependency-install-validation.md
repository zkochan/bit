# Isolated install acceptance gate

`install-validation.cjs` runs the real Bit CLI and the original `@pnpm/napi` installer. It does not replace installation with a no-op. The helper remains explicitly opt-in. This Linux-only lane checks correctness and native participation before any install timing is allowed.

```sh
node scripts/rust-dependency-analysis/install-validation.cjs \
  /tmp/bit-rust-cli-source \
  /absolute/path/bit-dependency-scanner \
  /tmp/install-validation-result.json
```

The CLI input must be a private build with the `.bit-rust-private-build.json` provenance marker. Its compiled module hashes are checked. The driver copies the complete installed snapshot into an owned temporary baseline, then gives each variant a fresh physical/reflink copy at the same absolute workspace path. It reroutes absolute internal symlinks, preserves dangling internal aliases, prunes dangling external aliases, and rejects live external aliases. It never installs in the supplied snapshot or the user checkout.

Each command runs in `unshare -Urn`, so the CLI and descendants have no external network interface. Hosts without this facility fail the gate. The command is `install --lockfile-only --skip-import --skip-compile --skip-write-config-files`. Both variants start with an empty dependency cacache, asserted before execution. The driver requests private package-store/cache paths and disables the global virtual store. Before invoking the real package manager, the observer rejects any actual store/cache path outside the private workspace; it records no registry credentials or proxy configuration. This safety check is conservative: a Bit configuration that ignores the requested paths blocks validation rather than modifying a shared store.

Acceptance requires both real commands to succeed, native helper requests with successful outcomes, real lockfile-only package-manager calls, exact dependency-cache records and package-manager project inputs, and matching resulting lockfile bytes. Empty calls or requests cannot produce a passing result. Each command has a two-minute timeout and bounded captured output. Temporary copies are removed on completion. Reports contain dependency/project data and up to 64 KiB of failure output; keep them private if workspace data is sensitive. No install timing or speedup claim is produced by this script.

## Current result

The October 7, 2026 Linux/x64 probe used Node 24.21.0, the trusted private CLI built from `b262e69d4`, and helper SHA-256 `23525b6a895a6e566c4273d73bbfd9a3d5492daf2b1107ae09eb9745c5e797d0`. Both variants passed the empty-cache assertion, then exited with `Cannot find module '@teambit/legacy'` during component linking. The snapshot's alias pointed outside the private tree to an absent `.bvm` installation and was pruned by the safety gate. Each run produced 334 dependency-cache records, but neither started the helper or invoked the package manager. Acceptance failed; those records do not establish native parity.

A complete self-contained installed CLI snapshot with a working internal `@teambit/legacy` package is needed before repeating this lane. The private store settings were never exercised because linking failed first. There is no successful install, no verified native install participation, and no install benchmark result yet. Existing command/helper benchmark results do not fill this gap.
