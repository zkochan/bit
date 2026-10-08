const mode = process.argv[2];
let input = Buffer.alloc(0);
if (mode === 'hung') process.on('SIGTERM', () => undefined);
process.stdin.on('data', (chunk) => {
  if (mode === 'hung') return;
  if (mode === 'crash') process.exit(7);
  input = Buffer.concat([input, chunk]);
  if (input.length < 12) return;
  const id = input.readUInt32BE(4);
  const count = input.readUInt32BE(8);
  let cursor = 12;
  const files = [];
  for (let index = 0; index < count; index++) {
    if (input.length < cursor + 24) return;
    const hash = input.subarray(cursor, cursor + 20).toString('hex');
    const length = input.readUInt32BE(cursor + 20);
    if (input.length < cursor + 24 + length) return;
    files.push({ hash, status: 'source', inflatedBytes: 100, reason: null });
    cursor += 24 + length;
  }
  const response = { version: 1, id, files };
  if (mode === 'bad-second') files[files.length - 1].hash = '0'.repeat(40);
  if (mode === 'wrong-id') response.id++;
  if (mode === 'bad-size') files[0].inflatedBytes = 2 ** 53;
  if (mode === 'missing') files.pop();
  if (mode === 'flood') process.stdout.write('x'.repeat(17000));
  else process.stdout.write(JSON.stringify(response) + (mode === 'extra' ? '\n{}\n' : '\n'));
  input = input.subarray(cursor);
});
