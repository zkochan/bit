# Standalone object-import release artifacts

Object-import artifacts can now be built and qualified independently of a Bit installation. This is the first distribution step; automatic installation and runtime discovery remain open. The runtime still opts in with an absolute executable path in `BIT_RUST_OBJECT_IMPORT`. The original `rust` branch and scanner packaging are unchanged.

## Build and validate locally

Run from the repository root with the pinned Rust toolchain installed and locked dependencies fetched:

```sh
(cd native && cargo fetch --locked)
node scripts/rust-object-import/artifacts/package-helper.cjs \
  --directory "$HOME/bit-object-import-artifacts" > /tmp/bit-object-artifact-path.txt
BIT_TEST_OBJECT_ARTIFACT="$(cat /tmp/bit-object-artifact-path.txt)" \
  node --test scripts/rust-object-import/artifacts/artifacts.test.cjs
node scripts/rust-object-import/artifacts/smoke.cjs \
  "$(cat /tmp/bit-object-artifact-path.txt)"
```

An optional `--target` selects an installed target from the matrix below. The packager always executes `cargo build --locked --offline --release --package bit-object-import --target TARGET`, sets its own Cargo output directory, and packages that checkout's release output. It accepts no arbitrary prebuilt binary. Source input identity is checked before and after the build. Git revision identifies checkout HEAD, and `gitParents` records its parent SHAs: pull-request CI checks out GitHub's transient merge commit, whose parents name the base and PR head. The source digest identifies native inputs even during development with uncommitted edits. Neither a checksum nor this provenance is a publisher signature.

Each artifact consists of a deterministic `.tar.gz`, an exact SHA256 sidecar, and a detached manifest identical to the embedded manifest. The archive contains only the executable, `manifest.json`, `LICENSE`, and `THIRD-PARTY-NOTICES.txt`. Rust standard-library/runtime notices reuse the scanner's existing pinned license texts. Cargo notices follow the object-import dependency closure, including build dependencies; scanner-only dependencies are excluded. No new Python, Cargo or npm dependencies are added.

Generated archives, manifests, reports and extracted helpers belong outside the source checkout. Output directories that resolve into the source repository are rejected, including redirects through symlinks. CI uploads archives as temporary Actions artifacts with 14-day retention; they are not committed or published as release assets.

## Platform qualification

| Target                      | Qualification                                                                                     |
| --------------------------- | ------------------------------------------------------------------------------------------------- |
| `x86_64-unknown-linux-gnu`  | Linux release build and native protocol smoke                                                     |
| `aarch64-unknown-linux-gnu` | ARM64 Linux release build and native protocol smoke                                               |
| `x86_64-apple-darwin`       | Intel macOS release build and native protocol smoke                                               |
| `aarch64-apple-darwin`      | ARM64 macOS release build and native protocol smoke                                               |
| `x86_64-pc-windows-msvc`    | Windows release build and native protocol smoke; existing runtime eligibility restrictions remain |
| `x86_64-unknown-linux-musl` | Cross-built release artifact executed inside actual Alpine on Node 22.13, 22.22 and 24            |

Each native artifact is tested on Node 22.13, 22.22 and 24. These CI jobs qualify executable packaging and the protocol, not every platform's complete import-command behavior. GNU artifacts record the maximum GLIBC requirement found in the binary's version names (including the GLIBC 2.36 requirement of `GLIBC_ABI_DT_RELR`). Validation checks that manifest requirement against the binary; smoke rejects hosts with an older GLIBC or different OS/architecture/ABI. ELF, Mach-O and PE architecture checks prevent target relabeling. A build on a newer Linux host can require newer GLIBC; packaging does not lower that requirement.

## Validation and remaining work

The archive reader accepts only flat regular USTAR members. It rejects duplicates, links, prefixes, traversal names, extra members, corrupt checksums, truncated members, missing terminators, trailing payload, compressed files over 64 MiB and expanded files over 80 MiB. Binary and notices limits are 64 MiB and 4 MiB; manifests are limited to 64 KiB. Archive and manifest sidecars must be bounded regular files and match exactly.

Tests cover deterministic byte preservation, malicious archives, decompression bounds, source/target/build contracts, executable architecture/ABI, changed sidecars, dependency closure, portable source identity, output restrictions, and the actual release helper. The real smoke uses a Unicode path, validates and commits a Source, checks native existence and verifies exact persisted compressed bytes.

Local validation passes all 12 artifact tests (including the real release executable), all 72 existing Node coordinator/repository tests, canonical isolated `npm run lint`, and inherited pnpm Rust formatting/Clippy/perfectionist checks with all 40 Rust workspace tests. The extracted release executable also passes the genuine 16,384-Source scope read/inventory qualification and complete compiled file/original HTTP-tar import-command smoke, including missing/crashing helper fallback. This reuses the existing compiled runtime because packaging does not change runtime sources. Other OS/ABI results require CI. Raw evidence remains outside Git.

Next distribution work is immutable installation, compiled-runtime identity binding, adjacent-only discovery, rollback, and deployment assembly. These artifacts do not change the default runtime behavior or establish whole-command performance gains.
