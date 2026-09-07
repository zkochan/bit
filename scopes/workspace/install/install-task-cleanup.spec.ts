import assert from 'node:assert/strict';
import { InstallMain } from './install.main.runtime';

describe('installation metadata lifetime', () => {
  for (const failure of ['manifest preparation', 'subsequent pre-install hook']) {
    it(`disposes prepared metadata when ${failure} fails`, async () => {
      const error = new Error(failure);
      let disposed = false;
      let downloaded = false;
      let published = false;
      const hooks: Array<() => Promise<any>> = [
        async () => ({
          run: async () => {
            downloaded = true;
          },
          cleanup: async () => {
            disposed = true;
          },
        }),
      ];
      if (failure === 'subsequent pre-install hook')
        hooks.push(async () => {
          throw error;
        });
      const workspace = {
        getWorkspaceConfig: () => ({ extensions: { findExtension: () => undefined } }),
        inInstallContext: false,
      };
      const install = Object.assign(Object.create(InstallMain.prototype), {
        workspace,
        preInstallSlot: { values: () => hooks },
        _installModules: async () => {
          throw error;
        },
        ipcEvents: {
          publishIpcEvent: async () => {
            published = true;
          },
        },
      }) as InstallMain;

      await assert.rejects(install.install(), (err) => err === error);
      assert.equal(disposed, true);
      assert.equal(downloaded, false);
      assert.equal(published, false);
      assert.equal(workspace.inInstallContext, false);
    });
  }
});

describe('metadata install compatibility', () => {
  function fixture() {
    return Object.assign(Object.create(InstallMain.prototype), {
      dependencyResolver: { hasRootComponents: () => true },
      workspace: { listIds: () => [] },
      envs: {},
      app: { getAppPatterns: () => [] },
      logger: { profileAsync: (_name, run) => run(), debug: () => {} },
    });
  }

  it('falls back when an environment or configured aspect remote has the old fetch protocol', async () => {
    const install = fixture();
    install.getRootPolicyFromMetadata = async () => {
      throw new Error('type component-metadata was not implemented');
    };
    const result = await install.prepareMetadataInstall(
      { load: async () => {} },
      { canInstallFromMetadata: () => true }
    );
    assert.equal(result.prepared, undefined);
  });

  it('propagates network failures during environment metadata preparation', async () => {
    const install = fixture();
    const error = new Error('connection reset');
    install.getRootPolicyFromMetadata = async () => {
      throw error;
    };
    await assert.rejects(
      install.prepareMetadataInstall({ load: async () => {} }, { canInstallFromMetadata: () => true }),
      (err) => err === error
    );
  });

  it('allows metadata preparation for dependency-graph restoration', async () => {
    const install = fixture();
    install.getRootPolicyFromMetadata = async () => ({});
    const result = await install.prepareMetadataInstall(
      { load: async () => {} },
      { canInstallFromMetadata: () => true },
      { restoreFromDependenciesGraph: true }
    );
    assert.ok(result.prepared);
  });

  it('keeps component-dependent subscribers and add-missing-dependencies on the existing path', async () => {
    const install = fixture();
    install.workspace.listIds = () => {
      throw new Error('must not prepare metadata');
    };
    assert.equal(
      (await install.prepareMetadataInstall({}, { canInstallFromMetadata: () => false })).prepared,
      undefined
    );
    assert.equal(
      (await install.prepareMetadataInstall({}, { canInstallFromMetadata: () => true }, { addMissingDeps: true }))
        .prepared,
      undefined
    );
  });
});
