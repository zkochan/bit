# Installing and opting into the packaged object helper

A trusted compiled Bit distribution can now include the standalone Rust object-import helper. `BIT_RUST_OBJECT_IMPORT=packaged` selects only the helper installed beside that distribution's object runtime. An absolute executable override remains supported. The default is still Node, and release assembly includes this experimental helper only when explicitly supplied with verified artifacts.

## Assemble a separate local distribution

Use a separate compiled Bit distribution containing this change. Do not compile or install into the original `rust` checkout. The existing private-copy preparation driver can rebuild the affected components from an already bootstrapped CLI, while preserving the original checkout and its installed modules.

From the checkout containing the assembler, build an artifact outside the repository:

```sh
(cd native && cargo fetch --locked)
node scripts/rust-object-import/artifacts/package-helper.cjs \
  --directory "$HOME/bit-object-import-artifacts" > /tmp/bit-object-artifact-path.txt
```

For a Linux x64 GNU distribution, explicitly assemble the helper:

```sh
node scripts/rust-object-import/artifacts/install-helper.cjs assemble \
  --distribution "$HOME/bit-test-distribution" \
  --archive "$(cat /tmp/bit-object-artifact-path.txt)" \
  --target x86_64-unknown-linux-gnu
BIT_RUST_OBJECT_IMPORT=packaged \
  node "$HOME/bit-test-distribution/bin/bit.js" import --objects COMPONENT_ID
```

Choose the matching target from [standalone-artifacts.md](./standalone-artifacts.md) on other systems. The distribution must contain compiled `@teambit/objects` and `@teambit/legacy.scope` packages. Assembly resolves their installed package locations and rejects runtime directories that escape the distribution. It does not fetch an artifact or compile Bit. Explicit cross-target assembly validates the artifact and target without executing the foreign binary; runtime discovery still checks the actual host.

For a single compiled object runtime, `install --module-directory DIRECTORY --archive ARCHIVE` performs the same installation and first smoke-tests the helper on the installation host. Both commands require the artifact's native source identity, including normalized Cargo lock contents, to match the assembler checkout. The assembler trusts the supplied compiled Bit build, then records its actual module hashes; this is build assembly, not a publisher-signature check.

## Release pipeline assembly

CircleCI's Linux x64/ARM64, macOS Intel/ARM64 and Windows bundle jobs run the Node assembler before compression. Set `BIT_RUST_OBJECT_IMPORT_ARTIFACT_DIRECTORY` to a directory attached to each bundle job containing the trusted standalone archives and both sidecars. Exactly one archive matching each bundle's target is required; unrelated targets are ignored. Missing, ambiguous, corrupt or incompatible supplied artifacts fail the bundle job. Leaving the variable unset preserves existing Node-only bundles.

The equivalent local command is:

```sh
BIT_RUST_OBJECT_IMPORT_ARTIFACT_DIRECTORY="$HOME/bit-object-import-artifacts" \
  node scripts/rust-object-import/artifacts/assemble-release.cjs \
  "$HOME/bit-test-distribution" x86_64-unknown-linux-gnu
```

The pipeline does not download artifacts or build Rust, and cross-target assembly does not execute a foreign helper. Artifact provisioning remains an explicit release-operator step; no release has been published by this change. Bundled helpers still require `BIT_RUST_OBJECT_IMPORT=packaged` at runtime. Alpine artifacts can use the same assembler explicitly with the musl target; the existing CircleCI bundle matrix has no Alpine bundle job.

## Selection, verification and rollback

Installed helpers are immutable under `packaged/VERSION/TARGET/REVISION`. Each directory contains the four validated artifact members. Reinstalling identical bytes is allowed; differing bytes, extra files, links and directory redirects are rejected. Installation stages files, explicitly sets executable/data permissions, flushes them and renames the completed directory. A lock serializes assembler changes. After a process crash, remove a leftover `.install-lock` only once no assembler owns it.

`packaged-build.json` binds the helper's source identity and manifest/binary hashes to the compiled object coordinators, repository and affected models. Import calls additionally verify the compiled legacy import coordinators. Read-only discovery does not load the legacy import graph. File fingerprints cache checksum results; a changed inode, size, modification time or change time requires re-verification. The executable and license/notices are also checked. No object-store contents or model instances are cached by discovery.

A single atomically replaced `packaged/selection.json` records the current and previous selections. The build contract is replaced before the selector; interruption between these steps can cause conservative fallback. This is not a transaction over the whole Bit distribution or a power-loss durability guarantee.

To select the previously installed compatible artifact:

```sh
node scripts/rust-object-import/artifacts/install-helper.cjs rollback \
  --module-directory "$HOME/bit-test-distribution/node_modules/@teambit/objects/dist/objects"
```

Rollback validates the previous directory, all artifact members, source identity, its bound artifact entry and the current compiled module hashes before swapping both selections atomically. Changed runtime code, tampered files or a helper from a different native source identity cannot be rolled back through this contract. Up to 32 compatible artifact entries are retained. Reinstalling the current artifact preserves the previous selection.

## Runtime behavior and qualification

Packaged discovery requires Node 22.13 or newer and a supported OS/architecture/ABI. GNU helpers additionally require the manifest's GLIBC minimum. Missing files, changed checksums/runtime modules, redirects, unsupported hosts or invalid selection/build contracts return to canonical Node behavior. An eligible helper that later crashes retains the existing protocol fallback. `off` disables the helper; relative overrides are ignored. Absolute overrides preserve their previous behavior and do not require a packaged build contract.

Windows packaging and Source validation are supported; batched existence checks and bounded raw repository reads also support Windows. Header timestamp classification, directory traversal and native persistence retain their Unix restrictions. Existing transformer/override/registry policies, operation limits, shared read-helper slots and independent rollback flags are unchanged. Packaged discovery adds verification work; this change does not claim a new import speedup or complete Rust feature parity.

The isolated platform tests compile the standalone coordinators into disposable package layouts and exercise real artifacts on Linux/macOS/Windows and actual Alpine at Node 22.13/22.22/24. They cover protocol use, cached tampering, source/build/host/selection rejection, redirects, immutable installation, compatible rollback, locking and adjacent-only search. Full compiled Bit command qualification remains a Linux local check, separate from those isolated layouts.

The existing genuine-scope driver accepts `BIT_READ_QUALIFICATION_PACKAGED=1`; the full file/HTTP command driver accepts `BIT_IMPORT_QUALIFICATION_PACKAGED=1`. Both require an assembled private CLI. The explicit `packaged-fallback` command mode checks canonical readback with an invalid installed helper and asserts that Sources did not execute natively. Fixtures, reports, installed contracts and archives remain outside Git.

Local validation passes 94 Node tests (including 12 artifact tests and 10 installation/discovery tests), 95 compiled object unit tests, 40 Rust workspace tests, strict coordinator TypeScript, canonical isolated `npm run lint` and inherited pnpm Rust formatter/Clippy/perfectionist checks. Packaged full file/original HTTP-tar import smoke verifies native Source/metadata/mutable stages and complete readback; the genuine 16,384-Source scope driver verifies exact reads, native existence, canonical header parity, repeated import and deletion repair. Removing the installed executable also passes full canonical command readback with zero native Sources. PR #43 passed all 17 runnable cross-platform checks; raw reports/logs stay outside Git.

Remaining distribution work includes trusted artifact provisioning in release jobs and broader full-command platform qualification. Native merge policy, larger streaming reads, tar intake, component/index transactions and operation orchestration remain separate stages.

## Windows read-only extension

Windows can use the existing BEX1 existence and BRD1 compressed-byte protocols for eligible batches of at least 1,024 hashes, through either an absolute executable or packaged discovery. The existing 4,096-hash raw operation, 128-file frame, 256 KiB per-file and 32 MiB transfer limits remain. Existence operations retain the 16,384-hash grouping. Ordering, duplicates, empty files, directory existence, live creation/deletion and canonical oversize/missing/error fallback are preserved. Neither operation writes to the repository or caches object contents.

The native platform coordinator tests now execute these paths on Windows rather than returning early. Packaged tests also exercise them on Windows at Node 22.13, 22.22 and 24, with paths containing spaces and Unicode. Unix permission and symlink cases stay Unix-only; Windows ACL and full compiled command qualification remain open. Portable malformed-reply tests verify whole-operation discard on every OS. No Windows performance improvement or full-command parity is claimed before measurement. Header/traversal and all native persistence restrictions remain unchanged.
