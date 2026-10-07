# Genuine local-only install validation

The isolated install gate now passes with a real source-bearing workspace. Twenty genuine Bit CLI installs ran in Linux network namespaces: two untimed parity proofs and nine interleaved legacy/native pairs. Every run successfully invoked the original lockfile-only package manager, kept its project/store/cache paths private, and reproduced exact dependency-cache records, package-manager project inputs, and lockfile bytes. Each cold run scanned four component trees; the native runs started one persistent helper and submitted 64 successful inline-source requests.

This closes the successful no-network install and native-participation gap from the earlier blocked full-repository probe. On this small workload, legacy median wall time was **570.16 ms**, native **587.06 ms** (native/legacy **1.030**). The native variant was about 3% slower in this sample. This result does not establish an install speedup. CPU and simultaneous process-tree memory remain a separate measurement step; the helper RSS snapshot fields in the raw trace are not a simultaneous memory measurement.

## Reproduction

Build a trusted private CLI with `command-build.cjs`, then use an explicitly supplied scanner executable. Setup and every install run require Linux `unshare -Urn`; no package manager is replaced and no network downloads occur.

```sh
node scripts/rust-dependency-analysis/install-fixture.cjs \
  /tmp/private-bit-cli /tmp/new-install-fixture
node scripts/rust-dependency-analysis/install-benchmark.cjs \
  /tmp/private-bit-cli /tmp/new-install-fixture \
  /absolute/path/bit-dependency-scanner /tmp/install-results.json
```

The fixture generator runs real `bit init`, `bit add`, and `bit link`. It verifies initialization and that all four components were tracked, preventing an analytics-consent prompt's zero exit code from masquerading as setup. An isolated `BIT_GLOBALS_DIR` disables analytics/error reporting through its own config. Sixty-four JavaScript sources contain relative chains and three local component-package imports. Supported package configuration points local package entry points at their JavaScript sources. The source hashes and setup revision are recorded in `.rust-install-fixture.json`.

The built-in Node environment requests unused type packages, and Bit's core environment roots request React packages. The fixture uses supported dependency policies to remove the unused type packages, and supported root policies/overrides to link React and React DOM to the existing installed private CLI packages. These are actual local package links, not synthetic package-manager responses. The runtime remains read-only; every install's `dir`, project roots, package store, cache, and Bit global directory are inside its disposable copy.

The driver physically copies the same fixture baseline for every run, reroutes absolute internal aliases, clears its `.bit/cache/components/deps`, and asserts zero cache entries before execution. Setup, restoration, hashing, and cache inspection are excluded from timings. The timing boundary includes Node/CLI startup through successful package-manager completion. A common private Node compile cache is reused; warm filesystem caches are expected. `BIT_INSTALL_BENCH_PROOF_ONLY=1` runs only the genuine parity proof, without measured pairs.

The recorded CLI source revision is `a72e7cb66dd52be1c86aacb8745296fa5147b461`, Node 24.21.0 on Linux/x64. The freshly built scanner includes the prototype-key fallback guard; its SHA-256 is `a5b4e2f5a77447e26d30c616850db456bfd918040a2ffce5dad60a4a74edd455`. The exact recorded results are in [dependency-install-local-results.json](dependency-install-local-results.json). This is a deliberately small local-only fixture; full-repository package resolution and uncached registry downloads are outside this result.
