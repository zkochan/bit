import { Readable } from 'stream';
import type { ObjectItemsStream } from './object-list';

/** Defer decoding until read, or hand the original body to one repository import owner. */
export function deferTarInput(input: Readable, decode: (input: Readable) => Readable): ObjectItemsStream {
  let decoder: Readable | undefined;
  let claimed = false;
  let demand = false;
  // Fetch can fail before its caller attaches a consumer. Retain the body's own errored/buffered state.
  const retainError = () => undefined;
  input.on('error', retainError);
  const stream: ObjectItemsStream = new Readable({
    objectMode: true,
    read() {
      demand = true;
      if (claimed) {
        this.push(null);
        return;
      }
      if (!decoder) {
        decoder = decode(input);
        decoder.on('readable', drain);
        decoder.on('end', () => this.push(null));
        decoder.on('error', (error) => this.destroy(error));
      }
      drain();
    },
    destroy(error, callback) {
      decoder?.destroy();
      if (!claimed) input.destroy();
      input.removeListener('error', retainError);
      callback(error);
    },
  });
  function drain() {
    if (!demand) return;
    let item;
    while (decoder && (item = decoder.read()) !== null) {
      if (!stream.push(item)) {
        demand = false;
        break;
      }
    }
  }
  stream.claimTarInput = () => {
    if (claimed || decoder || stream.destroyed || stream.readableFlowing !== null || stream.listenerCount('readable')) {
      return undefined;
    }
    claimed = true;
    // Keep the passive error listener until the new owner has disposed of the wrapper/body.
    return input;
  };
  return stream;
}
