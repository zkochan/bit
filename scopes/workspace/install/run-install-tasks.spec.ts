import assert from 'node:assert/strict';
import { runInstallTasks } from './run-install-tasks';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('runInstallTasks', () => {
  it('overlaps installation and remote loading and returns the installation result', async () => {
    const installing = deferred();
    const importing = deferred();
    const result = await runInstallTasks(async () => {
      installing.resolve();
      await importing.promise;
      return 'installed';
    }, [
      async () => {
        importing.resolve();
        await installing.promise;
      },
    ]);
    assert.equal(result, 'installed');
  });

  for (const failingTask of ['install', 'import']) {
    it(`waits for outstanding writes when ${failingTask} fails`, async () => {
      const release = deferred();
      const started = deferred();
      const error = new Error(`${failingTask} failed`);
      let settled = false;
      const fail = () => {
        throw error;
      };
      const wait = async () => {
        started.resolve();
        await release.promise;
      };
      const result = runInstallTasks(failingTask === 'install' ? fail : wait, [failingTask === 'import' ? fail : wait])
        .catch((err) => err)
        .then((value) => {
          settled = true;
          return value;
        });
      await started.promise;
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(settled, false);
      release.resolve();
      assert.equal(await result, error);
    });
  }
});
