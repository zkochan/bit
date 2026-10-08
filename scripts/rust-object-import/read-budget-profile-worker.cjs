const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createRequire } = require('node:module');
const [cli, directory, count, repeats] = process.argv.slice(2);
const { Repository, Ref } = createRequire(path.join(cli, 'package.json'))('@teambit/objects');
(async () => {
  const repo = new Repository(directory, { name: 'read-budget-profile' });
  repo.getPath = () => directory;
  const refs = Array.from({ length: Number(count) }, (_, i) => new Ref(i.toString(16).padStart(40, '0')));
  const expected = await fs.readFile(repo.objectPath(refs[0]));
  global.gc?.();
  for (let i = 0; i < Number(repeats); i++) {
    const result = await repo.loadManyRaw(refs);
    assert.equal(result.length, refs.length);
    result.forEach((object, index) => {
      assert.equal(object.ref, refs[index]);
      assert.ok(object.buffer.equals(expected));
    });
  }
  console.log(JSON.stringify({ count: Number(count), repeats: Number(repeats) }));
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
