import { expect } from 'chai';
import { Readable } from 'stream';
import { deferTarInput } from './tar-input-stream';

describe('deferred tar input', () => {
  it('hands off the unconsumed original input exactly once and preserves its owner on wrapper destruction', () => {
    const input = Readable.from([Buffer.from('archive')]);
    const stream = deferTarInput(input, () => {
      throw new Error('decode before claiming');
    });
    expect(input.readableFlowing).to.equal(null);
    expect(stream.claimTarInput?.()).to.equal(input);
    expect(stream.claimTarInput?.()).to.equal(undefined);
    stream.destroy();
    expect(input.destroyed).to.equal(false);
    input.destroy();
  });

  it('lazily decodes for ordinary consumers and prevents a later handoff', async () => {
    const input = Readable.from([Buffer.from('archive')]);
    let calls = 0;
    const stream = deferTarInput(input, () => {
      calls++;
      return Readable.from([{ value: 1 }, { value: 2 }]);
    });
    expect(calls).to.equal(0);
    const items: { value: number }[] = [];
    for await (const item of stream) items.push(item);
    expect(items).to.deep.equal([{ value: 1 }, { value: 2 }]);
    expect(calls).to.equal(1);
    expect(stream.claimTarInput?.()).to.equal(undefined);
    expect(input.destroyed).to.equal(true);
  });

  it('retains decoder backpressure and drains every object in order', async () => {
    let produced = 0;
    const input = Readable.from([]);
    const stream = deferTarInput(input, () =>
      Readable.from(
        (function* () {
          for (let index = 0; index < 100; index++) {
            produced++;
            yield index;
          }
        })(),
        { highWaterMark: 1 }
      )
    );
    stream.read(0);
    await new Promise((resolve) => setImmediate(resolve));
    expect(produced).to.be.lessThan(20);
    const items: number[] = [];
    for await (const item of stream) items.push(item);
    expect(items).to.deep.equal(Array.from({ length: 100 }, (_, index) => index));
  });
});
