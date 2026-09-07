import type { Workspace } from '@teambit/workspace';
import type { InstallTask } from '@teambit/install';
import type { ComponentID } from '@teambit/component-id';
import { ModelComponent, Source, Version } from '@teambit/objects';
import type { Ref } from '@teambit/objects';
import { BuildStatus } from '@teambit/legacy.constants';

/** Load pinned dependency metadata, leaving source bodies for the package-manager phase. */
export async function prepareInstallMetadata(
  workspace: Workspace,
  refresh: () => Promise<void>
): Promise<InstallTask | undefined> {
  // Lane imports change heads as well. Keep their existing merge ordering.
  if (workspace.consumer.isOnLane()) return undefined;
  const scope = workspace.scope.legacyScope;
  const ids: ComponentID[] = [];
  const existingIds: ComponentID[] = [];
  for (const id of workspace.consumer.bitMap.getAllBitIdsFromAllLanes()) {
    if (!id.hasScope()) continue;
    if (!id.hasVersion()) return undefined;
    // Never replace a local model (which can contain unexported tags/snaps) with a remote snapshot.
    if (!(await scope.getModelComponentIfExist(id.changeVersion(undefined)))) {
      if (!scope.isExported(id)) return undefined;
      ids.push(id);
    } else {
      existingIds.push(id);
    }
  }
  if (!ids.length) return undefined;
  for (const id of existingIds) {
    try {
      const version = await scope.getVersionInstance(id);
      if (version.buildStatus !== BuildStatus.Succeed && version.buildStatus !== BuildStatus.Skipped) return undefined;
      const refs = version.refsWithOptions(false, false);
      if ((await scope.objects.hasMultiple(refs)).length !== refs.length) return undefined;
      if (version.flattenedDependencies.length && !(await version.getFlattenedEdges(scope.objects)).length)
        return undefined;
    } catch {
      return undefined;
    }
  }

  let metadata;
  try {
    metadata = await scope.scopeImporter.getManyRemoteComponents(ids, {
      type: 'component-metadata',
      withoutDependencies: false,
      includeDependencies: false,
    });
  } catch (err: any) {
    // Old fetch servers explicitly reject unknown types. Authentication, network and data errors
    // must still fail the install rather than being mistaken for unsupported protocol versions.
    if (err.message?.includes('type component-metadata was not implemented')) return undefined;
    throw err;
  }
  const versions = metadata.getVersions();
  if (
    versions.some(
      (version) => version.buildStatus !== BuildStatus.Succeed && version.buildStatus !== BuildStatus.Skipped
    )
  ) {
    return undefined;
  }

  // Keep fetched objects detached from the repository and component caches. Reading installation
  // data must never make an incomplete component appear to have been imported.
  let objects = new Map(metadata.getAll().map((object) => [object.hash().toString(), object]));
  const load = async (moreIds: ComponentID[]) => {
    if (!moreIds.length) return;
    const more = await scope.scopeImporter.getManyRemoteComponents(moreIds, {
      type: 'component-metadata',
      withoutDependencies: true,
      includeDependencies: false,
    });
    for (const object of more.getAll()) objects.set(object.hash().toString(), object);
  };
  const getVersion = async (id: ComponentID): Promise<Version | undefined> => {
    const modelRef = ModelComponent.fromBitId(id).hash();
    const model = objects.get(modelRef.toString());
    if (!(model instanceof ModelComponent)) {
      try {
        return await scope.getVersionInstance(id);
      } catch {
        return undefined;
      }
    }
    const ref = model.getRef(id.hasVersion() ? id.version! : model.getHeadRegardlessOfLaneAsTagOrHash(true));
    const version = ref && objects.get(ref.toString());
    return version instanceof Version ? version : undefined;
  };
  const getSource = async (ref: Ref): Promise<Buffer | undefined> => {
    const object = objects.get(ref.toString()) || (await scope.objects.load(ref, false));
    return object instanceof Source ? object.contents : undefined;
  };
  return {
    metadata: { getVersion, getSource, load },
    cleanup: async () => {
      objects = new Map();
    },
    run: async () => {
      await scope.scopeImporter.importInstallationObjects(ids);
      await refresh();
    },
  };
}
