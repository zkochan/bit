# Opt-in HTTP tar intake

The staged Rust tar path is now connected to the actual `Http.fetch()` and `ObjectFetcher` import path. It remains an explicit experiment; ordinary imports retain the existing decoder unless `BIT_RUST_OBJECT_TAR=on` is set alongside a selected object-import helper.

```sh
BIT_RUST_OBJECT_IMPORT=/absolute/path/to/bit-object-import \
BIT_RUST_OBJECT_TAR=on bit import
```

For a separately assembled distribution with its trusted helper installed, use `BIT_RUST_OBJECT_IMPORT=packaged` with the same tar flag. Existing packaged installations must be reassembled against the updated compiled runtime. The binding now verifies the HTTP module, deferred-input adapter and staging modules; a mismatched installation falls back. See [packaged-helper.md](./packaged-helper.md) for installation instructions. Unset the tar flag or set it to `off` to restore the original streaming decoder independently of other Rust stages.

The HTTP client returns a deferred object stream when the flag is on. ObjectFetcher may claim its original response body once, before decoding begins. Claiming requires a selected helper, Unix native store eligibility, unchanged repository methods/hooks and a mode other than `validate`. Otherwise the deferred stream starts the original decoder on first read. Callers outside ObjectFetcher also retain this ordinary object-stream behavior.

Production staging uses the previously qualified private-file transfer/replay implementation, now in TypeScript. It limits each archive to 2 GiB, admits four active stages and sixteen waiting operations per process, and applies a 120-second staging deadline. Active admission covers helper use and file cleanup. This bounds staged bytes to 8 GiB per process rather than reserving free space or establishing a machine-wide bound. Staging stays outside Git and removes its private archive after readers/helpers finish.

The operation waits for a complete HTTP transfer before invoking the kernel. A pre-policy disk/limit/admission or transfer failure can replay its exact written prefix, pending bytes and unread original response through the canonical decoder without refetching. Interrupted transfers retain complete Source entries and remote error attribution. After native policy begins, the completed-object cursor and settled Source reservations enable canonical suffix continuation without repeating metadata merges. Writable/repair failures and cancellation/deadlines remain terminal. Started canonical metadata writes may finish during cooperative cancellation.

This reduces Source tar parsing, validation and file writes to the native operation. Metadata still uses JavaScript policy and the existing mutable writer. Local file/remotes that provide ordinary object streams retain their current path. Windows retains its existing repository writer because native Source store eligibility is still Unix-only.

## Validation

```sh
BIT_LEGACY_ROOT=/tmp/private-compiled-bit \
  node --test scripts/rust-object-import/http-tar.test.cjs \
    scripts/rust-object-import/tar-adapter.test.cjs \
    scripts/rust-object-import/tar-coordination.test.cjs
```

Seven actual HTTP tests cover mixed Source/VersionHistory imports, off/missing-helper/custom-hook behavior, an interrupted original response, staging ENOSPC and packaged helper selection. The fixture uses the compiled production HTTP client, POST route and token/header handling with a test token, then the actual ObjectFetcher and repository. It checks persisted objects and one request, including the complete Source prefix on transport failure. Native and packaged cases require their respective helper/artifact; unsupported cases skip. These tests join the existing E2E shard-0 compiled repository step and require no extra full-command E2E suite.

Local results: all 27 repository/HTTP tests pass with the real helper and release artifact; 93 portable helper tests pass with one Windows-only skip; all 24 artifact/discovery tests pass, including HTTP-module tamper rejection; 109 compiled object tests pass with one pending; canonical isolated `npm run lint`, formatting and diff checks pass. Three new unit tests cover exclusive handoff, lazy ordinary decoding and backpressure. Qualification scripts use production transfer/staging code, including the existing cross-platform lifecycle/replay tests. No Rust changes, new lint exceptions or generated evidence are committed.

This establishes production API integration and functional fixture coverage. It does not establish a full `bit import` speedup or general peak-memory improvement. Next qualify genuine scopes and full commands against the JavaScript control, including mutable/component-heavy data, large transfers, concurrent remotes and filesystem/ACL cases, before considering default enablement. Broader native merges/index transactions and automatic release provisioning remain separate work.
