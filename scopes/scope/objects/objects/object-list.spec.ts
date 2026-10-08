import { expect } from 'chai';
import { Readable } from 'stream';
import tarStream from 'tar-stream';
import { ObjectList } from './object-list';
import type { ObjectItem } from './object-list';

type Entry = { name: string; contents?: string };
const start = (schema = '1.0.0'): Entry => ({
  name: '.BIT.START',
  contents: JSON.stringify({ schema, scopeName: 'fixture' }),
});
const end: Entry = { name: '.BIT.END', contents: '{"numOfFiles":999,"scopeName":"other"}' };

async function archive(entries: Entry[]): Promise<Buffer> {
  const pack = tarStream.pack();
  const chunks: Buffer[] = [];
  const completed = new Promise<Buffer>((resolve, reject) => {
    pack.on('data', (chunk: Buffer) => chunks.push(chunk));
    pack.on('error', reject);
    pack.on('end', () => resolve(Buffer.concat(chunks)));
  });
  entries.forEach(({ name, contents = '' }) => pack.entry({ name }, contents));
  pack.finalize();
  return completed;
}

async function decode(buffer: Buffer): Promise<{ objects: ObjectItem[]; error?: Error }> {
  const input = Readable.from([buffer]);
  const stream = ObjectList.fromTarToObjectStream(input);
  const objects: ObjectItem[] = [];
  try {
    return await new Promise((resolve) => {
      stream.on('data', (object: ObjectItem) => objects.push(object));
      stream.on('error', (error: Error) => resolve({ objects, error }));
      stream.on('end', () => resolve({ objects }));
    });
  } finally {
    input.destroy();
    stream.destroy();
  }
}

describe('ObjectList tar intake compatibility', () => {
  it('preserves unknown members, empty payloads and the first two path segments', async () => {
    const result = await decode(
      await archive([{ name: 'remote/unknown/extra', contents: 'arbitrary 日本語' }, { name: 'unscoped' }])
    );
    expect(result.error).to.equal(undefined);
    expect(
      result.objects.map((object) => [object.scope, object.ref.toString(), object.buffer.toString()])
    ).to.deep.equal([
      ['remote', 'unknown', 'arbitrary 日本語'],
      [undefined, 'unscoped', ''],
    ]);
  });

  it('does not validate END counts or scope names', async () => {
    const result = await decode(await archive([start(), { name: 'remote/object' }, end]));
    expect(result.error).to.equal(undefined);
    expect(result.objects).to.have.lengthOf(1);
  });

  it('accepts legacy archives and unknown schemas without an END marker', async () => {
    for (const entries of [[{ name: 'object' }], [start('future'), { name: 'object' }]]) {
      const result = await decode(await archive(entries));
      expect(result.error).to.equal(undefined);
      expect(result.objects).to.have.lengthOf(1);
    }
  });

  it('reports missing END after already emitting preceding objects', async () => {
    const result = await decode(await archive([start(), { name: 'object' }]));
    expect(result.objects).to.have.lengthOf(1);
    expect(result.error?.message).to.equal(
      'server terminated the stream unexpectedly (metadata: {"schema":"1.0.0","scopeName":"fixture"})'
    );
  });

  it('requires a truthy END marker for schema 1.0.0', async () => {
    for (const contents of ['null', 'false', '0', '""']) {
      const result = await decode(await archive([start(), { name: 'object' }, { name: '.BIT.END', contents }]));
      expect(result.objects).to.have.lengthOf(1);
      expect(result.error?.message).to.equal(
        'server terminated the stream unexpectedly (metadata: {"schema":"1.0.0","scopeName":"fixture"})'
      );
    }
  });

  it('rejects corrupted header checksums', async () => {
    const bytes = await archive([{ name: 'object', contents: 'content' }]);
    bytes[0] ^= 1;
    const result = await decode(bytes);
    expect(result.objects).to.have.lengthOf(0);
    expect(result.error?.message).to.equal(
      'Invalid tar header. Maybe the tar is corrupted or it needs to be gunzipped?'
    );
  });

  it('uses the last START marker and accepts END before START', async () => {
    const replacement = await decode(await archive([start(), start('future'), { name: 'object' }]));
    const reversed = await decode(await archive([end, start(), { name: 'object' }]));
    expect(replacement.error).to.equal(undefined);
    expect(reversed.error).to.equal(undefined);
    expect(replacement.objects).to.have.lengthOf(1);
    expect(reversed.objects).to.have.lengthOf(1);
  });

  it('preserves remote error text and stops before subsequent members', async () => {
    const result = await decode(
      await archive([
        start(),
        { name: 'before' },
        { name: '.BIT.ERROR', contents: 'remote failed: 日本語' },
        { name: 'after' },
      ])
    );
    expect(result.objects.map((object) => object.ref.toString())).to.deep.equal(['before']);
    expect(result.error?.message).to.equal('remote failed: 日本語');
  });

  it('continues after zero blocks in concatenated archives', async () => {
    const result = await decode(
      Buffer.concat([await archive([{ name: 'first' }]), await archive([{ name: 'second' }])])
    );
    expect(result.error).to.equal(undefined);
    expect(result.objects.map((object) => object.ref.toString())).to.deep.equal(['first', 'second']);
  });

  it('accepts complete entries without terminal zero blocks', async () => {
    const bytes = await archive([{ name: 'object', contents: 'content' }]);
    const result = await decode(bytes.subarray(0, -1024));
    expect(result.error).to.equal(undefined);
    expect(result.objects[0].buffer.toString()).to.equal('content');
  });

  it('rejects truncated bodies and partial trailing headers', async () => {
    const bytes = await archive([{ name: 'object', contents: 'content' }]);
    for (const buffer of [bytes.subarray(0, 515), Buffer.concat([bytes, Buffer.from([1])])]) {
      const result = await decode(buffer);
      expect(result.error?.message).to.equal('Unexpected end of data');
    }
  });

  it('preserves a PAX long filename without interpreting it as an extraction path', async () => {
    const scope = 'scope'.repeat(35);
    const result = await decode(await archive([{ name: `${scope}/object`, contents: 'content' }]));
    expect(result.error).to.equal(undefined);
    expect(result.objects[0].scope).to.equal(scope);
    expect(result.objects[0].ref.toString()).to.equal('object');
  });
});
