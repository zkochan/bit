// Run against the compiled graph on real Linux/macOS/Windows hosts.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const zlib = require('node:zlib');
const { installed } = require('./load-source.cjs');
const { Repository, NativeImportOperation } = installed('@teambit/objects');
const native =
  process.env.BIT_TEST_OBJECT_IMPORT ||
  path.resolve(__dirname, '../../native/target/debug/bit-object-import' + (process.platform === 'win32' ? '.exe' : ''));
async function setup(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bit-platform-metadata-'));
  const repo = await Repository.create({ scopePath: root, scopeJson: { name: 'metadata-test' } });
  await fs.mkdir(repo.getPath(), { recursive: true });
  const operation = new NativeImportOperation(native, { objectsDirectory: repo.getPath() });
  t.after(async () => {
    await operation.disposeAndWait();
    await fs.rm(root, { recursive: true, force: true });
  });
  return { root, repo, operation };
}
const sha = (number) => number.toString(16).padStart(40, '0');
function bytes(hash) {
  return Buffer.from(`Version ${hash} 2\0{}`);
}
async function nativeWrite(operation, hash) {
  return operation.request({ kind: 'persist', hash, serialized: bytes(hash).toString('hex') }, (value) => value);
}
async function metadata(file) {
  const stat = await fs.stat(file);
  let acl;
  if (process.platform === 'win32') {
    const script = file + '.acl.ps1';
    await fs.writeFile(script, 'param([string]$filename)\n(Get-Acl -LiteralPath $filename).Sddl\n');
    try {
      acl = cp
        .execFileSync(
          'powershell.exe',
          ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, file],
          { encoding: 'utf8' }
        )
        .trim();
    } finally {
      await fs.unlink(script);
    }
  } else if (process.platform === 'darwin') {
    acl = cp.execFileSync('ls', ['-lde', file], { encoding: 'utf8' }).split('\n').slice(1).join('\n');
  }
  return { mode: stat.mode, uid: stat.uid, gid: stat.gid, acl };
}
test('native object creation and replacement match canonical mode/owner/inherited ACL metadata', async (t) => {
  const { repo, operation } = await setup(t);
  const baseline = path.join(repo.getPath(), '00', sha(1).slice(2));
  const candidate = path.join(repo.getPath(), '00', sha(2).slice(2));
  await repo.writeObjectFile(baseline, zlib.deflateSync(bytes(sha(1))), null);
  assert.ok(await nativeWrite(operation, sha(2)), 'native path must run on the actual OS');
  assert.deepEqual(await metadata(candidate), await metadata(baseline));
  if (process.platform !== 'win32') {
    await fs.chmod(baseline, 0o640);
    await fs.chmod(candidate, 0o640);
  }
  await repo.writeObjectFile(baseline, zlib.deflateSync(bytes(sha(1))), null);
  assert.ok(await nativeWrite(operation, sha(2)));
  assert.deepEqual(await metadata(candidate), await metadata(baseline));
  assert.deepEqual(zlib.inflateSync(await fs.readFile(candidate)), bytes(sha(2)));
});
test(
  'Windows explicit object ACL replacement matches canonical atomic writer and readonly writes fall back',
  { skip: process.platform !== 'win32' },
  async (t) => {
    const { repo, operation } = await setup(t);
    const baseline = path.join(repo.getPath(), '00', sha(3).slice(2));
    const candidate = path.join(repo.getPath(), '00', sha(4).slice(2));
    await repo.writeObjectFile(baseline, zlib.deflateSync(bytes(sha(3))), null);
    assert.ok(await nativeWrite(operation, sha(4)));
    for (const filename of [baseline, candidate])
      cp.execFileSync('icacls.exe', [filename, '/grant', '*S-1-5-32-545:(R)'], { stdio: 'pipe' });
    await repo.writeObjectFile(baseline, zlib.deflateSync(bytes(sha(3))), null);
    assert.ok(await nativeWrite(operation, sha(4)));
    assert.deepEqual(await metadata(candidate), await metadata(baseline));
    for (const filename of [baseline, candidate]) await fs.chmod(filename, 0o444);
    try {
      let canonicalFailed = false;
      try {
        await repo.writeObjectFile(baseline, zlib.deflateSync(bytes(sha(3))), null);
      } catch {
        canonicalFailed = true;
      }
      const result = await nativeWrite(operation, sha(4));
      assert.equal(result === null, canonicalFailed, 'readonly replacement success/failure matches Node');
    } finally {
      for (const filename of [baseline, candidate]) await fs.chmod(filename, 0o666);
    }
  }
);
