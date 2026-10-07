# Sampled simultaneous command memory

The earlier reports added separately observed Node and helper high-water marks. The new Linux-only runner instead samples the RSS of the command and its observed descendants during the same sampling pass. It does not change ordinary Bit commands or scanner transport.

```sh
node --test scripts/rust-dependency-analysis/process-tree-memory.test.cjs
node scripts/rust-dependency-analysis/command-memory.cjs /tmp/bit-private-build /absolute/path/to/release/bit-dependency-scanner memory.json
```

Use a disposable current-source CLI with the provenance marker produced by `command-build.cjs`. The runner verifies the compiled runtime hashes and CLI version, rejects workspace/cache aliases, restores its own dependency-cache snapshots, and checks complete status JSON without normalization. Each cold/warm workload has a discarded warmup per variant followed by nine interleaved runs per variant. Cold runs start with zero dependency-cache entries; warm runs use the same primed snapshot. All accepted runs must finish with the expected component count. OS and the shared private Node compile cache are warm.

The driver starts GNU time and samples that process plus its descendants every 20 ms using Linux procfs. The driver itself is excluded. GNU time's small wrapper is included. Child discovery checks every thread's `children` file, deduplicates process IDs, and tracks process start times to reject unrelated PID reuse. Previously observed children remain tracked if their parent exits. Each record retains the peak sample's process list, sample count, maximum sampling gap/duration, missing/failed procfs reads, and sampler CPU. Node high-water and GNU time's maximum individual-process RSS are reported separately.

This is a near-simultaneous RSS sum assembled from sequential procfs reads, not an atomic kernel snapshot. Shared mapped pages count once for each process that maps them. Between-sample peaks and short-lived children can be missed; a process that exits during a read is reported as a missing-process read. The result is not USS/PSS, an exact maximum, or a sum of independent high-water marks. Compare the recorded sampling gaps and read quality before interpreting a run. GNU time's CPU excludes the external sampling driver; elapsed time includes the command's instrumented execution and the host's scheduling effects.

Seven sampler tests cover thread-child discovery, descendant deduplication, simultaneous versus independent peaks, orphan tracking, stale/PID-reused children, disappearing processes, input validation, and a real resident allocation with timer cleanup. They run in the existing Linux pipeline CI job. No packages beyond Node built-ins are required by the sampler tests.

The private builder also removes already-dangling external aliases from its copied dependencies, recording their count. An obsolete `@teambit/legacy` BVM alias exposed this case when copying the benchmark CLI. Live external links still fail the safety guard, and internal dangling links remain for later compilation. This cleanup affects only the disposable copy, never the installed dependency tree.
