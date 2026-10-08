const mode = process.argv[2];
let input = Buffer.alloc(0);
let id;
process.stdin.on('data', (chunk) => {
  if (mode === 'crash') process.exit(2);
  if (mode === 'hung') return;
  input = Buffer.concat([input, chunk]);
  if (input.length < 12) return;
  if (input.toString('ascii', 0, 4) === 'BOI2') {
    const count = input.readUInt32BE(8);
    const files = [];
    let offset = 12;
    for (let index = 0; index < count; index++) {
      if (input.length < offset + 24) return;
      const length = input.readUInt32BE(offset + 20);
      if (input.length < offset + 24 + length) return;
      files.push({
        hash: input.subarray(offset, offset + 20).toString('hex'),
        status: 'source',
        reason: null,
        inflatedBytes: 100,
      });
      offset += 24 + length;
    }
    id = input.readUInt32BE(4);
    input = input.subarray(offset);
    process.stdout.write(JSON.stringify({ version: 2, id: mode === 'wrong-validation' ? id + 1 : id, files }) + '\n');
  } else {
    if (mode === 'crash-commit') process.exit(2);
    const count = input.readUInt32BE(8);
    if (input.length < 12 + count * 4) return;
    const indices = Array.from({ length: count }, (_, i) => input.readUInt32BE(12 + i * 4));
    input = input.subarray(12 + count * 4);
    process.stdout.write(
      JSON.stringify({
        version: 2,
        id: mode === 'wrong-commit' ? id + 1 : id,
        persisted: mode === 'partial-commit' ? [] : indices,
        failed: [],
      }) + '\n'
    );
  }
});
