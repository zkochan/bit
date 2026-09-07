import fs from 'fs-extra';
import path from 'path';
import { isEqual, omit } from 'lodash';
import { parse } from 'comment-json';
import { matchPatterns, splitPatterns } from '@teambit/toolbox.path.match-patterns';
import { ComponentID } from '@teambit/component-id';
import { Source } from '@teambit/objects';
import type { Version } from '@teambit/objects';
import type { Workspace } from '@teambit/workspace';
import type { EnvsMain, EnvJsonc } from '@teambit/envs';
import { EnvPolicy, VariantPolicy, DependencyResolverAspect } from '@teambit/dependency-resolver';
import type { InstallComponentRecord } from '@teambit/dependency-resolver';
import { BuildStatus } from '@teambit/legacy.constants';
import type { InstallMetadata } from './install.main.runtime';

export type PreparedInstallRecords = {
  records: InstallComponentRecord[];
  directories: Map<string, string>;
  environments: Map<string, { id: ComponentID; packageName: string; policy: EnvPolicy }>;
};

/** Validate published inputs against the checkout before using them to install packages. */
export async function prepareInstallRecords(
  workspace: Workspace,
  envs: EnvsMain,
  metadata: InstallMetadata,
  onFallback: (reason: string) => void = () => {},
  appPatterns: string[] = [],
  hasPolicyProviders: (ids: string[]) => boolean = () => false
): Promise<PreparedInstallRecords | undefined> {
  const fallback = (reason: string) => {
    onFallback(reason);
    return undefined;
  };
  const { includePatterns, excludePatterns } = splitPatterns(appPatterns);
  const entries: Array<{ id: ComponentID; version: Version; envId: ComponentID; directory: string }> = [];
  const directories = new Map<string, string>();
  const envIds = new Map<string, ComponentID>();
  for (const id of workspace.listIds()) {
    if (!id.hasVersion() || !id.hasScope()) return fallback(`unpinned component ${id}`);
    const version = await metadata.getVersion(id);
    if (!version || ![BuildStatus.Succeed, BuildStatus.Skipped].includes(version.buildStatus!))
      return fallback(`unbuilt or missing version ${id}`);
    const data = version.extensions.findCoreExtension(DependencyResolverAspect.id)?.data;
    if (!data?.dependencies || !data.packageName) return fallback(`missing dependencies ${id}`);
    // Custom policy providers can require executable aspects. Preserve their existing lifecycle.
    if (data.policy?.some((entry) => entry.source === 'slots')) return fallback(`executable policy ${id}`);
    const entry = workspace.consumer.bitMap.getComponent(id);
    const directory = workspace.componentDir(id);
    const trackedFiles = entry.files.map((file) => file.relativePath).sort();
    if (!isEqual(trackedFiles, version.files.map((file) => file.relativePath).sort()))
      return fallback(`changed file list ${id}`);
    for (const file of version.files) {
      const contents = await fs.readFile(path.join(directory, file.relativePath));
      if (new Source(contents).hash().toString() !== file.file.toString())
        return fallback(`changed source ${id}: ${file.relativePath}`);
    }
    const merged = await workspace.componentExtensionsFromMetadata(id, version.extensions);
    if (hasPolicyProviders(merged.extensions.ids)) return fallback(`registered dependency policy ${id}`);
    if (merged.errors?.length) throw merged.errors[0];
    // Config changes can add/remove dependencies and change their lifecycle. Let the compatibility
    // loader perform that analysis rather than trusting the published dependency list.
    const installationConfig = (extensions) =>
      Object.fromEntries(
        extensions
          .filter((extension) => !['teambit.pkg/pkg', 'teambit.envs/envs'].includes(extension.stringId))
          .map((extension) => [extension.stringId, omit(extension.config || {}, ['__specific'])])
          .filter(([, config]) => Object.keys(config).length)
      );
    if (!isEqual(installationConfig(version.extensions), installationConfig(merged.extensions))) {
      return fallback(`changed component configuration ${id}`);
    }
    const originalPkgName = version.extensions.findCoreExtension('teambit.pkg/pkg')?.config?.packageJson?.name;
    const currentPkgName = merged.extensions.findCoreExtension('teambit.pkg/pkg')?.config?.packageJson?.name;
    if (originalPkgName !== currentPkgName) return fallback(`changed package name ${id}`);
    const envId = ComponentID.fromString(await envs.calculateEnvIdFromExtensions(merged.extensions));
    const originalEnv = ComponentID.fromString(await envs.calculateEnvIdFromExtensions(version.extensions));
    if (!envId.isEqual(originalEnv) || !envId.hasVersion() || workspace.hasId(envId))
      return fallback(`changed or local environment ${id}: ${envId}`);
    // Local applications and environments have additional roots and executable hooks.
    if (appPatterns.length && trackedFiles.some((file) => matchPatterns(file, includePatterns, excludePatterns)))
      return fallback(`application ${id}`);
    envIds.set(envId.toString(), envId);
    entries.push({ id, version, envId, directory });
    directories.set(id.toString(), directory);
  }
  await metadata.load([...envIds.values()]);
  const environments: PreparedInstallRecords['environments'] = new Map();
  const manifests = new Map<string, EnvJsonc>();
  const getEnvManifest = async (id: ComponentID, visiting = new Set<string>()): Promise<EnvJsonc | undefined> => {
    const key = id.toString();
    if (manifests.has(key)) return manifests.get(key);
    if (visiting.has(key)) throw new Error(`cyclic environment inheritance at ${key}`);
    visiting.add(key);
    let version = await metadata.getVersion(id);
    if (!version) {
      await metadata.load([id]);
      version = await metadata.getVersion(id);
    }
    const file = version?.files.find((item) => item.relativePath === 'env.jsonc');
    if (!version || !file) return undefined;
    const contents = await metadata.getSource(file.file);
    if (!contents) return undefined;
    let manifest = parse(contents.toString(), undefined, true) as EnvJsonc;
    if (manifest.extends) {
      const dependencies = version.extensions.findCoreExtension(DependencyResolverAspect.id)?.data?.dependencies || [];
      const dependency = dependencies.find((dep) => dep.packageName === manifest.extends);
      let parentId = dependency?.componentId
        ? ComponentID.fromObject(dependency.componentId)
        : manifest.extends.startsWith('@')
          ? undefined
          : ComponentID.fromString(manifest.extends);
      if (!parentId) return undefined;
      if (!parentId.hasVersion()) {
        const parent = version.dependencies.get().find((dep) => dep.id.isEqualWithoutVersion(parentId!));
        if (!parent) return undefined;
        parentId = parent.id;
      }
      const parent = await getEnvManifest(parentId, visiting);
      if (!parent) return undefined;
      manifest = envs.mergeEnvManifests(parent, manifest);
    }
    visiting.delete(key);
    manifests.set(key, manifest);
    return manifest;
  };
  for (const id of envIds.values()) {
    const manifest = await getEnvManifest(id);
    const version = await metadata.getVersion(id);
    const packageName = version?.extensions.findCoreExtension(DependencyResolverAspect.id)?.data?.packageName;
    if (!manifest?.policy || !packageName) return fallback(`missing environment manifest ${id}`);
    environments.set(id.toString(), {
      id,
      packageName,
      policy: EnvPolicy.fromConfigObject(manifest.policy, {}, id.toStringWithoutVersion()),
    });
  }
  const records: InstallComponentRecord[] = entries.map(({ id, version, envId }) => {
    const ext = version.extensions.findCoreExtension(DependencyResolverAspect.id)!;
    return {
      id,
      packageName: ext.data.packageName,
      dependencies: ext.data.dependencies,
      policy: VariantPolicy.parse(ext.data.policy || []),
      envPolicy: environments.get(envId.toString())!.policy,
      explicitPackages: new Set(
        Object.values(ext.config.policy || {}).flatMap((section: any) =>
          Object.keys(section).filter((name) => section[name] !== '-' && section[name]?.version !== '-')
        )
      ),
      missingPackages: { devMissings: [], runtimeMissings: [] },
    };
  });
  return { records, directories, environments };
}
