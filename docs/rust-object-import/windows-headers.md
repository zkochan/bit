# Windows header classification

Eligible Windows object inventories can now classify compressed headers through the existing BHD1 Rust protocol. At least 256 hashes are required. Up to four 4,096-hash frames share one invocation, preserving request order and the 8 MiB response bound. Native helper selection remains opt-in; `BIT_RUST_OBJECT_HEADERS=off` independently restores canonical classification. Traversal and native writes keep their existing platform restrictions.

Node retains registered-type policy, unreadable reporting, custom methods, transformers and model/Ref identity. Rust reads only the existing 512-byte compressed prefix and drains its partial inflater before accepting a header, preserving corruption fallback. No content cache or filesystem-snapshot guarantee is introduced.

## Timestamp compatibility

Accepted headers must match canonical `fs.stat()` size and `mtimeMs` exactly. Node converts seconds and nanoseconds to milliseconds in [its pinned stats implementation](https://github.com/nodejs/node/blob/955266bfdd854cd280dffd47548673914484e4c0/lib/internal/fs/utils.js#L406). Its [Windows binding casts time fields to unsigned long](https://github.com/nodejs/node/blob/955266bfdd854cd280dffd47548673914484e4c0/src/node_file-inl.h#L85). Rust therefore declines pre-epoch times and Windows seconds beyond the unsigned 32-bit range, allowing canonical classification to preserve Node's behavior. The existing fused conversion remains: integer seconds multiplied by 1,000 are exactly representable throughout the admitted Windows range.

Tests compare actual native headers to Node stat results for fractional timestamps, epoch zero, dates beyond 2038 and the upper Windows seconds boundary. A post-boundary Windows timestamp and pre-epoch files require fallback. These are strict comparisons, without rounding or tolerances. Rust unit tests cover the same conversion boundaries independent of filesystem support.

## Qualification

The platform coordinator suite now executes real Windows header classification, partial-inflate corruption/truncation parity and multi-frame ordering. Portable malformed-header replies must discard the complete operation. Packaged-helper tests exercise Windows headers at Node 22.13, 22.22 and 24 in paths containing spaces and Unicode.

Local Linux validation and Windows CI results are recorded with the PR. Windows full compiled commands, ACL behavior and performance measurements remain open; this extension does not claim Windows speedups or complete Rust feature parity. Generated evidence stays outside Git.
