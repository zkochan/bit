// Experimental staged-archive protocol client. Normal Bit imports do not call this interface.
const assert = require('node:assert/strict');
const cp = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs/promises');
const MAX_FRAME = 8 * 1024 * 1024 + 1;
async function readTarBatches(executable, archive, options, consume) {
  const size = (await fs.stat(archive)).size;
  const args = options.objectsDirectory ? ['--objects-dir', options.objectsDirectory] : [];
  const child = cp.spawn(executable, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  let output = Buffer.alloc(0),
    failure,
    pending,
    ending = false,
    closed = false;
  let frames = [],
    sequence = 0,
    count = 0,
    persisted = 0,
    killTimer;
  let rejectInterrupted;
  const interrupted = new Promise((_, reject) => {
    rejectInterrupted = reject;
  });
  interrupted.catch(() => undefined);
  const stopped = new Promise((resolve) =>
    child.once('close', (code) => {
      closed = true;
      clearTimeout(killTimer);
      if (code !== 0 || !ending) fail(new Error(`tar helper exited (${code})`));
      resolve();
    })
  );
  function fail(error) {
    if (failure) return;
    failure = error;
    rejectInterrupted(error);
    pending?.reject(error);
    pending = undefined;
    if (!closed) {
      child.kill();
      killTimer = setTimeout(() => child.kill('SIGKILL'), 250);
    }
  }
  child.on('error', fail);
  for (const stream of [child.stdin, child.stdout, child.stderr]) stream.on('error', fail);
  child.stderr.on('data', () => undefined);
  child.stdout.on('data', (chunk) => {
    if (failure) return;
    if (output.length + chunk.length > MAX_FRAME) return fail(new Error('oversized tar response'));
    output = Buffer.concat([output, chunk]);
    let newline;
    try {
      while ((newline = output.indexOf(10)) >= 0) {
        const frame = JSON.parse(output.subarray(0, newline).toString());
        output = output.subarray(newline + 1);
        if (pending) {
          pending.resolve(frame);
          pending = undefined;
        } else {
          frames.push(frame);
          assert.ok(frames.length <= 2, 'unsolicited tar responses');
        }
      }
    } catch (error) {
      fail(error);
    }
  });
  const timer = setTimeout(() => fail(new Error('tar operation timed out')), options.timeoutMs || 120000);
  function next() {
    if (failure) return Promise.reject(failure);
    if (frames.length) return Promise.resolve(frames.shift());
    return new Promise((resolve, reject) => {
      pending = { resolve, reject };
    });
  }
  function write(bytes) {
    if (failure) return Promise.reject(failure);
    return new Promise((resolve, reject) => child.stdin.write(bytes, (error) => (error ? reject(error) : resolve())));
  }
  try {
    const archivePath = Buffer.from(path.resolve(archive));
    const request = Buffer.alloc(16 + archivePath.length);
    request.write('BTI1');
    request.writeUInt32BE(1, 4);
    request.writeUInt32BE(options.digest ? 1 : 0, 8);
    request.writeUInt32BE(archivePath.length, 12);
    archivePath.copy(request, 16);
    await write(request);
    for (;;) {
      const response = await next();
      assert.equal(response.version, 1);
      assert.equal(response.id, 1);
      assert.equal(response.sequence, sequence);
      assert.equal(typeof response.done, 'boolean');
      assert.equal(typeof response.fallback, 'boolean');
      assert.ok(response.error === null || typeof response.error === 'string');
      assert.ok(Array.isArray(response.files));
      if (response.done) {
        assert.equal(response.files.length, 0);
        ending = true;
        child.stdin.end();
        await stopped;
        if (failure) throw failure;
        assert.equal(frames.length, 0);
        assert.equal(output.length, 0);
        if (response.error) throw new Error(response.error);
        if (response.fallback) throw new Error('native tar fallback required');
        return { count, persisted, batches: sequence };
      }
      assert.equal(response.fallback, false);
      assert.equal(response.error, null);
      assert.ok(response.files.length >= 1 && response.files.length <= 16);
      for (const file of response.files) validate(file, size, options.digest);
      const decision = await Promise.race([Promise.resolve().then(() => consume(response.files)), interrupted]);
      const selected = decision.selected || [];
      assert.equal(new Set(selected).size, selected.length);
      for (const index of selected) {
        assert.ok(Number.isSafeInteger(index) && index >= 0 && index < response.files.length);
        assert.equal(response.files[index].validation?.status, 'source');
      }
      const commit = Buffer.alloc(16 + selected.length * 4);
      commit.write('BTC1');
      commit.writeUInt32BE(1, 4);
      commit.writeUInt32BE(sequence, 8);
      commit.writeUInt32BE(selected.length, 12);
      selected.forEach((index, offset) => commit.writeUInt32BE(index, 16 + offset * 4));
      await write(commit);
      const ack = await next();
      assert.equal(ack.version, 1);
      assert.equal(ack.id, 1);
      assert.equal(ack.sequence, sequence);
      assert.ok(Array.isArray(ack.persisted) && Array.isArray(ack.failed));
      const coverage = [...ack.persisted, ...ack.failed];
      assert.equal(coverage.length, selected.length);
      assert.equal(new Set(coverage).size, coverage.length);
      assert.ok(coverage.every((index) => selected.includes(index)));
      if (ack.failed.length) throw new Error('native tar Source persistence failed');
      persisted += ack.persisted.length;
      count += response.files.length;
      sequence++;
      if (decision.error) throw decision.error;
    }
  } finally {
    clearTimeout(timer);
    if (!closed) fail(new Error('tar session disposed'));
    await stopped;
  }
}
function validate(file, size, digest) {
  assert.equal(typeof file.name, 'string');
  assert.ok(Buffer.byteLength(file.name) <= 65536);
  assert.ok(Number.isSafeInteger(file.offset) && file.offset >= 0);
  assert.ok(Number.isSafeInteger(file.size) && file.size >= 0 && file.size <= 128 * 1024 * 1024);
  assert.ok(file.offset + file.size <= size);
  assert.ok(digest ? /^[a-f0-9]{40}$/.test(file.sha1) : file.sha1 === null);
  const marker = ['.BIT.START', '.BIT.END', '.BIT.ERROR'].includes(file.name);
  assert.ok(marker ? typeof file.text === 'string' && Buffer.byteLength(file.text) <= 65536 * 3 : file.text === null);
  if (file.validation) {
    const value = file.validation;
    const hash = file.name.split('/')[1] ?? file.name;
    assert.equal(value.hash, hash);
    if (value.status === 'source') {
      assert.equal(value.reason, null);
      assert.ok(
        Number.isSafeInteger(value.inflatedBytes) &&
          value.inflatedBytes >= 1 &&
          value.inflatedBytes <= 1024 * 1024 * 1024
      );
    } else {
      assert.equal(value.status, 'legacy');
      assert.equal(value.inflatedBytes, 0);
      assert.equal(typeof value.reason, 'string');
    }
  }
}
module.exports = { readTarBatches };
