const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const path = require('node:path');
const fs = require('node:fs');
const { root, source } = require('./load-source.cjs');
const { RustSourceValidator, createRustSourceValidator } = source(
  'components/legacy/scope/objects-fetcher/rust-source-validator.ts'
);
const native =
  process.env.BIT_TEST_OBJECT_IMPORT ||
  path.join(root, 'native/target/debug/bit-object-import' + (process.platform === 'win32' ? '.exe' : ''));
assert.ok(fs.existsSync(native), 'real object-import helper required; build native/object-import first');
function object(value) {
  const contents = Buffer.isBuffer(value) ? value : Buffer.from(value);
  const hash = crypto.createHash('sha1').update(contents).digest('hex');
  const buffer = zlib.deflateSync(
    Buffer.concat([Buffer.from(`Source ${hash} ${contents.toString().length}\0`), contents])
  );
  return { hash, buffer, size: zlib.inflateSync(buffer).length };
}
function validator(context, executable = native, timeout = 10000, args = []) {
  const value = new RustSourceValidator(executable, timeout, args);
  context.after(() => value.dispose());
  return value;
}

test('real helper verifies empty, Unicode, binary and multi-chunk Sources in ordered batches', async (context) => {
  const v = validator(context);
  const items = ['', 'unicode 🚀 日本語', Buffer.from([0, 255, 254, 1]), Buffer.alloc(4 * 1024 * 1024, 65)].map(object);
  const results = await Promise.all(items.map((item) => v.validate(item.hash, item.buffer)));
  results.forEach((result, index) => assert.deepEqual(result, { inflatedBytes: items[index].size }));
  assert.equal(v.stats.sources, 4);
  assert.equal(v.stats.batches, 1);
});

test('mutable/unknown types, wrong identity, corruption, every truncation and trailing data retain legacy', async (context) => {
  const v = validator(context);
  const item = object('payload');
  assert.equal(await v.validate('0'.repeat(40), item.buffer), undefined);
  const other = zlib.deflateSync(Buffer.from(`Version ${item.hash} 2\0{}`));
  assert.equal(await v.validate(item.hash, other), undefined);
  const corrupt = Buffer.from(item.buffer);
  corrupt[corrupt.length - 1] ^= 1;
  assert.equal(await v.validate(item.hash, corrupt), undefined);
  for (let length = 1; length < item.buffer.length; length++) {
    assert.equal(await v.validate(item.hash, item.buffer.subarray(0, length)), undefined, `length ${length}`);
  }
  assert.equal(await v.validate(item.hash, Buffer.concat([item.buffer, Buffer.from('extra')])), undefined);
  assert.deepEqual(await v.validate(item.hash, item.buffer), { inflatedBytes: item.size });
  assert.equal(v.unavailableReason, undefined);
});

for (const mode of ['bad-second', 'wrong-id', 'bad-size', 'missing', 'extra', 'flood', 'crash']) {
  test(`invalid ${mode} response resolves entire batch to fallback before any success`, async (context) => {
    const v = validator(context, process.execPath, 1000, [path.join(__dirname, 'fake-validator.cjs'), mode]);
    const first = object('first');
    const second = object('second');
    assert.deepEqual(
      await Promise.all([v.validate(first.hash, first.buffer), v.validate(second.hash, second.buffer)]),
      [undefined, undefined]
    );
    assert.ok(v.unavailableReason);
  });
}

test('timeout cancels active/queued work and terminates a helper that ignores SIGTERM', async (context) => {
  const v = validator(context, process.execPath, 150, [path.join(__dirname, 'fake-validator.cjs'), 'hung']);
  const item = object('waiting');
  const promises = Array.from({ length: 40 }, () => v.validate(item.hash, item.buffer));
  assert.ok((await Promise.all(promises)).every((result) => result === undefined));
  assert.match(v.unavailableReason, /timed out/);
  await new Promise((resolve) => setTimeout(resolve, 350));
  assert.ok(v.child.exitCode !== null || v.child.signalCode !== null);
});

test('missing executable and disposal do not leave pending work', async (context) => {
  const item = object('input');
  const missing = validator(context, path.join(root, 'missing-import-helper'));
  assert.equal(await missing.validate(item.hash, item.buffer), undefined);
  const disposed = validator(context);
  const pending = disposed.validate(item.hash, item.buffer);
  disposed.dispose();
  assert.equal(await pending, undefined);
  assert.equal(disposed.child, undefined);
});

test('count/byte eligibility bounds and invalid refs fall back without native submission', async (context) => {
  const v = validator(context);
  const item = object('bounded');
  assert.equal(await v.validate('bad-ref', item.buffer), undefined);
  assert.equal(await v.validate(item.hash, Buffer.alloc(0)), undefined);
  assert.equal(await v.validate(item.hash, Buffer.allocUnsafe(128 * 1024 * 1024 + 1)), undefined);
  const results = await Promise.all(Array.from({ length: 65 }, () => v.validate(item.hash, item.buffer)));
  assert.equal(results.filter(Boolean).length, 64);
  assert.equal(v.stats.submitted, 64);
  assert.equal(v.bytes, 0);
});

test('selector defaults off, ignores relative paths, and honors absolute executable paths', () => {
  const original = process.env.BIT_RUST_OBJECT_IMPORT;
  try {
    for (const value of ['', 'off', 'control', './helper']) {
      process.env.BIT_RUST_OBJECT_IMPORT = value;
      assert.equal(createRustSourceValidator(), undefined);
    }
    process.env.BIT_RUST_OBJECT_IMPORT = native;
    const selected = createRustSourceValidator();
    assert.ok(selected instanceof RustSourceValidator);
    selected.dispose();
  } finally {
    if (original === undefined) delete process.env.BIT_RUST_OBJECT_IMPORT;
    else process.env.BIT_RUST_OBJECT_IMPORT = original;
  }
});
