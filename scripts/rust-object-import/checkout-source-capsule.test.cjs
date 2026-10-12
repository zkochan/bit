const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { installed, source } = require('./load-source.cjs');
const { Repository, Source, BitObject } = installed('@teambit/objects');
const compiled = process.env.BIT_TEST_CHECKOUT_SOURCE_COMPILED === '1';
const files = compiled
  ? installed('@teambit/component.sources/dist/rust-checkout-source.js')
  : source('scopes/component/sources/rust-checkout-source.ts');
const api = compiled
  ? installed('@teambit/component.sources/dist/rust-checkout-source-capsule.js')
  : source('scopes/component/sources/rust-checkout-source-capsule.ts');
async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'bit-checkout-capsule-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const repository = new Repository(directory, {});
  const value = Source.from(Buffer.from('raw\r\n'));
  const reference = value.hash();
  const compressed = await value.compress();
  const filename = repository.objectPath(reference);
  await fs.mkdir(path.dirname(filename), { recursive: true });
  await fs.writeFile(filename, compressed);
  const row = {
    hash: reference.toString(),
    offset: 0,
    bodySize: value.contents.length,
    compressedSize: compressed.length,
  };
  const bytes = Buffer.concat([value.contents, compressed]);
  const issue = async () => {
    const session = {
      request: async (_build, _count, validate) =>
        validate({ completed: 1, failed: false, data: { files: [row] } }, bytes),
    };
    return (await api.readRustCheckoutCapsules(session, [reference.toString()], () => Buffer.alloc(0)))[0];
  };
  return {
    repository,
    reference,
    filename,
    value,
    compressed,
    capsule: await issue(),
    changedCapsule: await issue(),
    missingCapsule: await issue(),
  };
}
test('verified raw Source reuse requires exact current compressed bytes and preserves raw EOLs', async (t) => {
  const f = await fixture(t);
  const loaded = api.loadRustCheckoutCapsule(f.repository, f.reference, f.capsule);
  assert.ok(loaded instanceof Source);
  assert.equal(api.loadRustCheckoutCapsule(f.repository, f.reference, f.capsule), undefined);
  assert.equal(api.loadRustCheckoutCapsule(f.repository, f.reference, {}), undefined);
  assert.deepEqual(loaded.contents, f.value.contents);
  await fs.writeFile(f.filename, Buffer.from('changed compressed bytes'));
  assert.equal(api.loadRustCheckoutCapsule(f.repository, f.reference, f.changedCapsule), undefined);
  await fs.rm(f.filename);
  assert.equal(api.loadRustCheckoutCapsule(f.repository, f.reference, f.missingCapsule), undefined);
});
test('a replaced public synchronous parser remains canonical and is not invoked speculatively', async (t) => {
  const f = await fixture(t);
  const original = Object.getOwnPropertyDescriptor(BitObject, 'parseSync');
  let calls = 0;
  Object.defineProperty(BitObject, 'parseSync', {
    ...original,
    value() {
      calls++;
      return f.value;
    },
  });
  t.after(() => Object.defineProperty(BitObject, 'parseSync', original));
  assert.equal(api.loadRustCheckoutCapsule(f.repository, f.reference, f.capsule), undefined);
  assert.equal(calls, 0);
  assert.strictEqual(f.repository.loadSync(f.reference), f.value);
  assert.equal(calls, 1);
});
test('raw capsule validation rejects gaps, bad identities, and trailing bytes before publishing', async (t) => {
  const f = await fixture(t);
  const hash = f.reference.toString();
  const bytes = Buffer.concat([f.value.contents, f.compressed]);
  const row = { hash, offset: 0, bodySize: f.value.contents.length, compressedSize: f.compressed.length };
  async function read(rows, body = bytes) {
    const session = {
      request: async (_build, _count, validate) => {
        validate({ completed: 1, failed: false, data: { files: rows } }, body);
      },
    };
    return api.readRustCheckoutCapsules(session, [hash], () => Buffer.alloc(0));
  }
  const loaded = await read([row]);
  assert.deepEqual(api.loadRustCheckoutCapsule(f.repository, f.reference, loaded[0]).contents, f.value.contents);
  for (const malformed of [
    { ...row, offset: 1 },
    { ...row, hash: '0'.repeat(40) },
    { ...row, compressedSize: 0 },
    { ...row, bodySize: -1 },
  ]) {
    assert.equal(await read([malformed]), undefined);
  }
  assert.equal(await read([row], Buffer.concat([bytes, Buffer.from([0])])), undefined);
  assert.equal(await read([row], Buffer.alloc(bytes.length)), undefined);
});

function lazyFile(f, capsule = f.capsule) {
  return files.createRustCheckoutSourceFile(
    { file: f.reference, relativePath: 'index.js', name: 'index.js', test: false },
    f.repository,
    true,
    capsule
  );
}
test('live pending and cache aliases override private capsule bytes at the lazy getter', async (t) => {
  for (const pending of [false, true]) {
    const f = await fixture(t);
    const file = lazyFile(f);
    if (pending) f.repository.objects[f.reference.toString()] = f.value;
    else f.repository.setCache(f.value);
    f.value.contents = Buffer.from('live replacement');
    await fs.rm(f.filename);
    assert.strictEqual(file.contents, f.value.contents);
  }
});
test('a changed valid disk Source is observed by the canonical loader after capsule freshness fails', async (t) => {
  const f = await fixture(t);
  const file = lazyFile(f);
  const changed = Source.from(Buffer.from('new bytes'));
  await fs.writeFile(f.filename, await changed.compress());
  assert.deepEqual(file.contents, changed.contents);
});
test('missing disk Source reproduces the canonical public error instead of serving an old capsule', async (t) => {
  const f = await fixture(t);
  const file = lazyFile(f);
  await fs.rm(f.filename);
  assert.throws(
    () => file.contents,
    (error) => error.constructor.name === 'HashNotFound'
  );
});
