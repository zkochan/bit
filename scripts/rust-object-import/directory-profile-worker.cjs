const assert = require('node:assert/strict');
const path = require('node:path');
const { createRequire } = require('node:module');
const [cli, directory, count, repeats] = process.argv.slice(2);
const { Repository } = createRequire(path.join(cli, 'package.json'))('@teambit/objects');
(async () => {
  const repo = new Repository(directory, { name: 'profile' });
  repo.getPath = () => directory;
  global.gc?.();
  for (let i = 0; i < Number(repeats); i++) {
    const result = await repo.listObjectsWithType();
    assert.equal(result.objects.length, Number(count));
    assert.equal(result.unreadable.length, 0);
    assert.ok(result.objects.every((object) => object.type === 'Source'));
  }
  console.log(JSON.stringify({ count: Number(count), repeats: Number(repeats) }));
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
