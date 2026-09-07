import type { Workspace } from '@teambit/workspace';
import { BuildStatus } from '@teambit/legacy.constants';

/** Remote refreshes may overlap installation only when the pinned metadata is complete locally. */
export async function canImportDuringInstall(workspace: Workspace): Promise<boolean> {
  // Lane imports also merge lane heads. Preserve their ordering relative to manifest preparation.
  if (workspace.consumer.isOnLane()) return false;
  const scope = workspace.scope.legacyScope;
  const ids = workspace.consumer.bitMap.getAllBitIdsFromAllLanes().filter((id) => id.hasScope());
  for (const id of ids) {
    if (!id.hasVersion()) return false;
    try {
      const version = await scope.getVersionInstance(id);
      // An unbuilt version can acquire new dependency metadata during the import.
      if (version.buildStatus !== BuildStatus.Succeed && version.buildStatus !== BuildStatus.Skipped) return false;
      const refs = version.refsWithOptions(false, false);
      if ((await scope.objects.hasMultiple(refs)).length !== refs.length) return false;
      // Without flattened edges the importer must fetch dependency versions as well.
      if (version.flattenedDependencies.length && !(await version.getFlattenedEdges(scope.objects)).length)
        return false;
    } catch {
      // Missing or unreadable local objects need the usual import before manifests are calculated.
      return false;
    }
  }
  return true;
}
