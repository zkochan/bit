import assert from 'node:assert/strict';
import { BuildStatus } from '@teambit/legacy.constants';
import { canImportDuringInstall } from './can-import-during-install';

function fixture() {
  const version = {
    buildStatus: BuildStatus.Succeed,
    refsWithOptions: () => ['source'],
    flattenedDependencies: ['dependency'],
    getFlattenedEdges: async () => ['edge'],
  };
  const id = { hasScope: () => true, hasVersion: () => true };
  const scope = {
    getVersionInstance: async () => version,
    objects: { hasMultiple: async (refs: string[]) => refs },
  };
  const workspace = {
    consumer: { isOnLane: () => false, bitMap: { getAllBitIdsFromAllLanes: () => [id] } },
    scope: { legacyScope: scope },
  };
  return { workspace, scope, version, id };
}

describe('canImportDuringInstall', () => {
  it('allows a remote refresh with complete, built local metadata', async () => {
    assert.equal(await canImportDuringInstall(fixture().workspace as any), true);
  });

  it('keeps lane imports before manifest preparation', async () => {
    const { workspace } = fixture();
    workspace.consumer.isOnLane = () => true;
    assert.equal(await canImportDuringInstall(workspace as any), false);
  });

  it('fetches first when a pinned version is missing', async () => {
    const { workspace, scope } = fixture();
    scope.getVersionInstance = async () => {
      throw new Error('missing version');
    };
    assert.equal(await canImportDuringInstall(workspace as any), false);
  });

  it('fetches first when referenced objects are missing', async () => {
    const { workspace, scope } = fixture();
    scope.objects.hasMultiple = async () => [];
    assert.equal(await canImportDuringInstall(workspace as any), false);
  });

  it('fetches first when build metadata can still change', async () => {
    const { workspace, version } = fixture();
    version.buildStatus = BuildStatus.Pending;
    assert.equal(await canImportDuringInstall(workspace as any), false);
  });

  it('fetches first when dependency edges are unavailable', async () => {
    const { workspace, version } = fixture();
    version.getFlattenedEdges = async () => [];
    assert.equal(await canImportDuringInstall(workspace as any), false);
  });

  it('fetches first for unpinned scoped components', async () => {
    const { workspace, id } = fixture();
    id.hasVersion = () => false;
    assert.equal(await canImportDuringInstall(workspace as any), false);
  });
});
