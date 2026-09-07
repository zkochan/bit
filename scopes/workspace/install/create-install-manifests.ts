import type { ProjectManifest } from '@pnpm/types';
import type { AspectLoaderMain } from '@teambit/aspect-loader';
import type { Logger } from '@teambit/logger';
import { getRootComponentDir } from '@teambit/workspace.root-components';
import { snapToSemver } from '@teambit/component-package-version';
import { SemVer } from 'semver';
import { WorkspaceManifestFactory } from '@teambit/dependency-resolver';
import type {
  DependencyResolverMain,
  WorkspacePolicy,
  GetComponentManifestsOptions,
  PackageManagerInstallOptions,
} from '@teambit/dependency-resolver';
import type { PreparedInstallRecords } from './prepare-install-records';

type Options = Omit<GetComponentManifestsOptions, 'componentDirectoryMap' | 'rootPolicy' | 'rootDir'> &
  Pick<PackageManagerInstallOptions, 'nodeLinker'>;

/** Use the same manifest rules as the Component adapter, with detached inputs. */
export async function createInstallManifests(
  prepared: PreparedInstallRecords,
  rootPolicy: WorkspacePolicy,
  options: Options,
  {
    dependencyResolver,
    aspectLoader,
    logger,
    rootDir,
    rootComponentsPath,
  }: {
    dependencyResolver: DependencyResolverMain;
    aspectLoader: AspectLoaderMain;
    logger: Logger;
    rootDir: string;
    rootComponentsPath: string;
  }
) {
  const factory = new WorkspaceManifestFactory(
    dependencyResolver,
    aspectLoader,
    logger,
    dependencyResolver.config.resolveEnvPeersFromRoot ?? true,
    dependencyResolver.config.forceEnvPeersToRoot ?? false
  );
  const result = await factory.createFromRecords(
    'workspace',
    new SemVer('1.0.0'),
    rootPolicy,
    rootDir,
    prepared.records,
    {
      ...options,
      filterComponentsFromManifests: true,
      createManifestForComponentsWithoutDependencies: true,
      referenceLocalPackages: options.nodeLinker === 'isolated',
    }
  );
  const manifests: Record<string, ProjectManifest> = {};
  for (const record of prepared.records) {
    const manifest = result.componentsManifestsMap.get(record.packageName);
    if (manifest)
      manifests[prepared.directories.get(record.id.toString())!] = manifest.toJson({
        copyPeerToRuntime: options.copyPeerToRuntimeOnComponents,
      });
  }
  manifests[rootDir] = result.toJson({
    copyPeerToRuntime: options.copyPeerToRuntimeOnRoot,
    resolveEnvPeersFromRoot: options.resolveEnvPeersFromRoot,
  });
  const workspaceDeps = dependencyResolver.getWorkspaceDepsOfBitRoots(
    Object.values(manifests).filter(({ name }) => name !== 'workspace')
  );
  const rootDirs: string[] = [];
  for (const env of prepared.environments.values()) {
    const dir = getRootComponentDir(rootComponentsPath, env.id.toString());
    rootDirs.push(dir);
    const envManifest = {
      dependencies: {
        ...Object.fromEntries(
          env.policy.selfPolicy.entries
            .filter(({ force, value }) => force && value.version !== '-')
            .map(({ dependencyId, value }) => [
              dependencyId,
              value.version === '+' ? workspaceDeps[dependencyId] || '*' : value.version,
            ])
        ),
        ...workspaceDeps,
        [env.packageName]: snapToSemver(env.id.version!),
      },
      installConfig: { hoistingLimits: 'workspaces' },
    };
    manifests[dir] = envManifest;
  }
  return { manifests, peerOverrides: result.peerOverrides, rootDirs };
}
