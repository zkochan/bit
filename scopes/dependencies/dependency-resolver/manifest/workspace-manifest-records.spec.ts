import assert from 'node:assert/strict';
import { SemVer } from 'semver';
import { ComponentID } from '@teambit/component-id';
import {
  ComponentDependency,
  ComponentDependencyFactory,
  DependencyListFactory,
  type DependencyFactory,
  type SerializedDependency,
} from '../dependencies';
import { EnvPolicy, VariantPolicy, WorkspacePolicy } from '../policy';
import { WorkspaceManifestFactory, type InstallComponentRecord } from './workspace-manifest-factory';

describe('workspace manifests from install records', () => {
  it('keeps local links and policy precedence without loading components or mutating published dependencies', async () => {
    const a = ComponentID.fromString('acme.ui/button@1.0.0');
    const b = ComponentID.fromString('acme.ui/icon@1.0.0');
    const external = ComponentID.fromString('acme.ui/theme@1.0.0');
    const dependency = (id: ComponentID, packageName: string) =>
      new ComponentDependency(
        id,
        false,
        packageName,
        id.toString(),
        id.version!,
        'runtime'
      ).serialize<SerializedDependency>();
    const listFactory = new DependencyListFactory({
      component: new ComponentDependencyFactory({} as any) as unknown as DependencyFactory,
    });
    const resolver = {
      hasRootComponents: () => true,
      getDependenciesFromSerializedDependencies: (dependencies) => listFactory.fromSerializedDependencies(dependencies),
      getDependencies: () => {
        throw new Error('must not load a Component');
      },
      getComponentEnvPolicy: () => {
        throw new Error('must use detached env policy');
      },
    };
    const record = (id: ComponentID, packageName: string): InstallComponentRecord => ({
      id,
      packageName,
      dependencies: [],
      policy: VariantPolicy.getEmpty(),
      envPolicy: EnvPolicy.fromConfigObject({}),
      explicitPackages: new Set(),
      missingPackages: { devMissings: [], runtimeMissings: [] },
    });
    const records = [record(a, '@acme/ui.button'), record(b, '@acme/ui.icon')];
    records[0].dependencies = [dependency(b, '@acme/ui.icon'), dependency(external, '@acme/ui.theme')];
    const published = JSON.stringify(records[0].dependencies);
    const factory = new WorkspaceManifestFactory(resolver as any, { getCoreAspectIds: () => [] } as any);
    const policy = new WorkspacePolicy([
      { dependencyId: '@acme/ui.theme', lifecycleType: 'runtime', value: { version: '2.0.0' } },
    ]);
    const result = await factory.createFromRecords('workspace', new SemVer('1.0.0'), policy, '/workspace', records, {
      filterComponentsFromManifests: true,
      createManifestForComponentsWithoutDependencies: true,
      referenceLocalPackages: true,
    });
    const manifest = result.componentsManifestsMap.get('@acme/ui.button')!.toJson();
    assert.equal(manifest.dependencies?.['@acme/ui.icon'], 'workspace:*');
    assert.equal(manifest.dependencies?.['@acme/ui.theme'], '2.0.0');
    assert.equal(result.componentsManifestsMap.get('@acme/ui.button')!.component, undefined);
    assert.equal(JSON.stringify(records[0].dependencies), published);
  });
});
