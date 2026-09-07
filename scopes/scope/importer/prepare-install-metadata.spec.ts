import assert from 'node:assert/strict';
import { ComponentID } from '@teambit/component-id';
import { ModelComponent, Source, Version, Ref } from '@teambit/objects';
import { BuildStatus } from '@teambit/legacy.constants';
import { prepareInstallMetadata } from './prepare-install-metadata';

function fixture() {
  const events: string[] = [];
  const id = ComponentID.fromString('acme.ui/button@1.0.0');
  const source = new Source(Buffer.from('env policy'));
  const model = ModelComponent.fromBitId(id);
  const versionRef = new Ref('1234567890123456789012345678901234567890');
  model.versions['1.0.0'] = versionRef;
  model.head = versionRef;
  const version = Object.assign(Object.create(Version.prototype), {
    hash: () => versionRef,
    buildStatus: BuildStatus.Succeed,
    flattenedDependencies: [],
    getFlattenedEdges: async () => [],
  });
  const scope = {
    isExported: () => true,
    getModelComponentIfExist: async () => undefined as any,
    getVersionInstance: async () => version,
    scopeImporter: {
      getManyRemoteComponents: async (_ids, opts) => {
        assert.equal(opts.type, 'component-metadata');
        events.push('metadata');
        return { getVersions: () => [version], getAll: () => [model, version, source] };
      },
      importInstallationObjects: async () => {
        events.push('payload');
      },
    },
    objects: {
      load: async () => undefined,
      beginInstallationMetadata: () => {
        events.push('begin');
        return () => {
          events.push('release');
        };
      },
    },
  };
  const workspace = {
    consumer: { isOnLane: () => false, bitMap: { getAllBitIdsFromAllLanes: () => [id] } },
    scope: { legacyScope: scope },
    clearCache: async () => {
      events.push('clear');
    },
  };
  const refresh = async () => {
    events.push('refresh');
  };
  return { workspace, scope, version, events, refresh, id, source };
}

describe('prepareInstallMetadata', () => {
  it('keeps fetched metadata detached and never clears component caches', async () => {
    const { workspace, events, refresh } = fixture();
    const task = await prepareInstallMetadata(workspace as any, refresh);
    assert.ok(task);
    assert.deepEqual(events, ['metadata']);
    await task.run();
    await task.cleanup();
    assert.deepEqual(events, ['metadata', 'payload', 'refresh']);
  });

  it('reads pinned and latest versions and env sources without publishing objects to the repository', async () => {
    const { workspace, scope, version, refresh, id, source } = fixture();
    const task = await prepareInstallMetadata(workspace as any, refresh);
    assert.equal(await task!.metadata!.getVersion(id), version);
    assert.equal(await task!.metadata!.getVersion(id.changeVersion(undefined)), version);
    assert.deepEqual(await task!.metadata!.getSource(source.hash()), source.contents);
    await task!.cleanup();
    scope.getVersionInstance = async () => {
      throw new Error('not imported');
    };
    assert.equal(await task!.metadata!.getVersion(id), undefined);
    assert.equal(await task!.metadata!.getSource(source.hash()), undefined);
  });

  it('can clean up if manifest preparation fails before the source download starts', async () => {
    const { workspace, events, refresh } = fixture();
    const task = await prepareInstallMetadata(workspace as any, refresh);
    await task!.cleanup();
    assert.deepEqual(events, ['metadata']);
  });

  it('cleans up a failed payload download without running refresh', async () => {
    const { workspace, scope, events, refresh } = fixture();
    const error = new Error('download failed');
    scope.scopeImporter.importInstallationObjects = async () => {
      throw error;
    };
    const task = await prepareInstallMetadata(workspace as any, refresh);
    await assert.rejects(task!.run(), (err) => err === error);
    assert.deepEqual(events, ['metadata']);
  });

  it('falls back when the remote does not implement metadata fetches', async () => {
    const { workspace, scope, refresh } = fixture();
    scope.scopeImporter.getManyRemoteComponents = async () => {
      throw new Error('type component-metadata was not implemented');
    };
    assert.equal(await prepareInstallMetadata(workspace as any, refresh), undefined);
  });

  it('does not swallow network failures', async () => {
    const { workspace, scope, refresh } = fixture();
    const error = new Error('connection reset');
    scope.scopeImporter.getManyRemoteComponents = async () => {
      throw error;
    };
    await assert.rejects(prepareInstallMetadata(workspace as any, refresh), (err) => err === error);
  });

  it('does not use build metadata that can still change', async () => {
    const { workspace, version, events, refresh } = fixture();
    version.buildStatus = BuildStatus.Pending;
    assert.equal(await prepareInstallMetadata(workspace as any, refresh), undefined);
    assert.deepEqual(events, ['metadata']);
  });

  it('does not request missing unexported components from a remote', async () => {
    const { workspace, scope, events, refresh } = fixture();
    scope.isExported = () => false;
    assert.equal(await prepareInstallMetadata(workspace as any, refresh), undefined);
    assert.deepEqual(events, []);
  });

  it('keeps lane imports sequential', async () => {
    const { workspace, events, refresh } = fixture();
    workspace.consumer.isOnLane = () => true;
    assert.equal(await prepareInstallMetadata(workspace as any, refresh), undefined);
    assert.deepEqual(events, []);
  });
});
