// Small in-memory archives for differential intake qualification; no generated evidence in Git.
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { createRequire } = require('node:module');
const path = require('node:path');
const load = createRequire(path.join(process.env.BIT_LEGACY_ROOT || path.resolve(__dirname, '../..'), 'package.json'));
const tar = load('tar-stream');
const headers = load('tar-stream/headers');
function typeFlag(bytes, flag) {
  const result = Buffer.from(bytes);
  result[156] = flag.charCodeAt(0);
  result.fill(32, 148, 156);
  const sum = result.subarray(0, 512).reduce((total, byte) => total + byte, 0);
  result.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 'ascii');
  return result;
}
function source(contents) {
  const bytes = Buffer.from(contents);
  const hash = crypto.createHash('sha1').update(bytes).digest('hex');
  return {
    name: `fixture/${hash}`,
    buffer: zlib.deflateSync(Buffer.concat([Buffer.from(`Source ${hash} ${bytes.toString().length}\0`), bytes])),
  };
}
async function archive(entries) {
  const pack = tar.pack();
  const chunks = [];
  const completed = new Promise((resolve, reject) => {
    pack.on('data', (chunk) => chunks.push(chunk));
    pack.on('error', reject);
    pack.on('end', () => resolve(Buffer.concat(chunks)));
  });
  for (const entry of entries)
    pack.entry({ mtime: new Date(0), ...entry.header, name: entry.name }, entry.buffer || Buffer.alloc(0));
  pack.finalize();
  return completed;
}
const marker = (name, value) => ({ name: `.BIT.${name}`, buffer: Buffer.from(JSON.stringify(value)) });
const start = () => marker('START', { schema: '1.0.0', scopeName: 'fixture' });
const end = (numOfFiles = 0) => marker('END', { numOfFiles, scopeName: 'fixture' });
async function fixtures() {
  const items = ['', '🚀 日本語', Buffer.from([0, 255, 254]), Buffer.alloc(64 * 1024, 97)].map(source);
  const normal = await archive([start(), ...items, end(items.length)]);
  const long = { name: `${'scope'.repeat(35)}/${items[0].name.split('/')[1]}`, buffer: items[0].buffer };
  const body = await archive([{ name: 'unknown', buffer: Buffer.alloc(1024, 98) }]);
  const checksum = Buffer.from(normal);
  checksum[0] ^= 1;
  return {
    normal,
    'legacy-no-markers': await archive(items),
    empty: await archive([]),
    'missing-end': await archive([start(), items[0]]),
    'other-schema-no-end': await archive([marker('START', { schema: '2.0.0', scopeName: 'fixture' }), items[0]]),
    'unchecked-end-count': await archive([start(), ...items, end(999)]),
    'end-before-start': await archive([end(), start(), items[0]]),
    'last-start-wins': await archive([start(), marker('START', { schema: 'other', scopeName: 'last' }), items[0]]),
    'unknown-members': await archive([
      { name: 'unexpected/path/more', buffer: Buffer.from('unknown') },
      { name: 'no-scope', buffer: Buffer.alloc(0) },
    ]),
    'remote-error': await archive([
      start(),
      items[0],
      { name: '.BIT.ERROR', buffer: Buffer.from('remote failed: 日本語') },
      items[1],
    ]),
    'bad-checksum': checksum,
    'truncated-body': body.subarray(0, 512 + 123),
    'without-zero-trailer': normal.subarray(0, -1024),
    'partial-tail': Buffer.concat([normal, Buffer.from([1])]),
    'concatenated-archives': Buffer.concat([await archive([items[0]]), await archive([items[1]])]),
    'pax-long-name': await archive([long]),
    'gnu-long-name': Buffer.concat([
      typeFlag(await archive([{ name: '././@LongLink', buffer: Buffer.from(long.name + '\0') }]), 'L').subarray(
        0,
        -1024
      ),
      await archive([{ ...items[0], name: 'short' }]),
    ]),
    'pax-global': Buffer.concat([
      typeFlag(
        await archive([{ name: 'global', buffer: headers.encodePax({ pax: { path: 'global/override' } }) }]),
        'g'
      ).subarray(0, -1024),
      await archive([items[0]]),
    ]),
    'null-end': await archive([start(), items[0], { name: '.BIT.END', buffer: Buffer.from('null') }]),
    'false-end': await archive([start(), items[0], { name: '.BIT.END', buffer: Buffer.from('false') }]),
    'invalid-start-json': await archive([{ name: '.BIT.START', buffer: Buffer.from('{invalid') }, items[0]]),
    'empty-ref': await archive([{ name: 'scope/' }]),
    directory: await archive([{ name: 'directory/', header: { type: 'directory' } }]),
  };
}
module.exports = { archive, source, fixtures, start, end };
