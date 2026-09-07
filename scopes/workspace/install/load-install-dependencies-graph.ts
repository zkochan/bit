import type { ComponentID } from '@teambit/component-id';
import { DependenciesGraph } from '@teambit/objects';
import type { InstallMetadata } from './install.main.runtime';

/** Read graph sources from the detached fetch result, without importing or loading Components. */
export async function loadInstallDependenciesGraph(
  ids: ComponentID[],
  metadata: InstallMetadata
): Promise<DependenciesGraph | undefined> {
  let merged: DependenciesGraph | undefined;
  for (const id of ids) {
    const version = await metadata.getVersion(id);
    if (!version?.dependenciesGraphRef) continue;
    const source = await metadata.getSource(version.dependenciesGraphRef);
    // Match Version.loadDependenciesGraph: older remotes can omit the referenced source,
    // and unsupported graph schemas are ignored. Malformed graph data still throws.
    if (!source) continue;
    const graph = DependenciesGraph.deserialize(source.toString());
    if (!graph || graph.isEmpty()) continue;
    // Each graph is deserialized here, so merging never mutates a cached Version graph.
    if (!merged) merged = graph;
    else merged.merge(graph);
  }
  return merged;
}
