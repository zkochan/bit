import assert from 'node:assert/strict';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import { ComponentID } from '@teambit/component-id';
import { Source } from '@teambit/objects';
import { BuildStatus } from '@teambit/legacy.constants';
import { DependencyResolverAspect } from '@teambit/dependency-resolver';
import { prepareInstallRecords } from './prepare-install-records';

function extensions(data: any, policy = {}) {
  const entries = [{ stringId: DependencyResolverAspect.id, data, config: { policy } }];
  return Object.assign(entries, {
    ids: [DependencyResolverAspect.id],
    findCoreExtension: (id: string) => entries.find((entry) => entry.stringId === id),
  });
}

describe('prepareInstallRecords', () => {
  let directory: string;
  beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'install-records-'));
  });
  afterEach(async () => {
    await fs.remove(directory);
  });

  async function fixture() {
    const id = ComponentID.fromString('acme.ui/button@1.0.0');
    const envId = ComponentID.fromString('acme.envs/react@1.0.0');
    const contents = Buffer.from('export const button = true;');
    await fs.writeFile(path.join(directory, 'index.ts'), contents);
    const envSource = new Source(
      Buffer.from(JSON.stringify({ policy: { runtime: [{ name: 'react', version: '18.0.0', force: true }] } }))
    );
    const version: any = {
      buildStatus: BuildStatus.Succeed,
      files: [{ relativePath: 'index.ts', file: new Source(contents).hash() }],
      extensions: extensions({ packageName: '@acme/ui.button', dependencies: [], policy: [] }),
    };
    const envVersion: any = {
      files: [{ relativePath: 'env.jsonc', file: envSource.hash() }],
      extensions: extensions({ packageName: '@acme/envs.react' }),
    };
    const workspace: any = {
      listIds: () => [id],
      hasId: () => false,
      componentDir: () => directory,
      consumer: { bitMap: { getComponent: () => ({ files: [{ relativePath: 'index.ts' }] }) } },
      componentExtensionsFromMetadata: async () => ({ extensions: version.extensions }),
      getMany: () => {
        throw new Error('must not load components');
      },
    };
    const envs: any = {
      calculateEnvIdFromExtensions: async () => envId.toString(),
      mergeEnvManifests: (parent, child) => ({ ...parent, ...child, extends: undefined }),
    };
    const metadata: any = {
      getVersion: async (requested) => (requested.isEqual(id) ? version : envVersion),
      getSource: async () => envSource.contents,
      load: async () => {},
    };
    return { id, envId, version, envVersion, envSource, workspace, envs, metadata };
  }

  it('builds plain install inputs and environment roots without loading a Component', async () => {
    const { workspace, envs, metadata, envId } = await fixture();
    const prepared = await prepareInstallRecords(workspace, envs, metadata);
    assert.ok(prepared);
    assert.equal(prepared.records[0].component, undefined);
    assert.equal(prepared.records[0].packageName, '@acme/ui.button');
    assert.equal(prepared.environments.get(envId.toString())?.packageName, '@acme/envs.react');
  });

  it('falls back for edited sources before downloading environment metadata', async () => {
    const { workspace, envs, metadata } = await fixture();
    await fs.writeFile(path.join(directory, 'index.ts'), 'changed');
    metadata.load = () => {
      throw new Error('unexpected metadata download');
    };
    assert.equal(await prepareInstallRecords(workspace, envs, metadata), undefined);
  });

  it('falls back for added files, changed dependency policies, and executable policy providers', async () => {
    const { workspace, envs, metadata, version } = await fixture();
    workspace.consumer.bitMap.getComponent = () => ({
      files: [{ relativePath: 'index.ts' }, { relativePath: 'new.ts' }],
    });
    assert.equal(await prepareInstallRecords(workspace, envs, metadata), undefined);
    workspace.consumer.bitMap.getComponent = () => ({ files: [{ relativePath: 'index.ts' }] });
    workspace.componentExtensionsFromMetadata = async () => ({
      extensions: extensions({}, { dependencies: { react: '19.0.0' } }),
    });
    assert.equal(await prepareInstallRecords(workspace, envs, metadata), undefined);
    workspace.componentExtensionsFromMetadata = async () => ({ extensions: version.extensions });
    version.extensions.findCoreExtension(DependencyResolverAspect.id).data.policy.push({ source: 'slots' });
    assert.equal(await prepareInstallRecords(workspace, envs, metadata), undefined);
  });

  it('preserves application and local-environment loading', async () => {
    const { workspace, envs, metadata } = await fixture();
    assert.equal(await prepareInstallRecords(workspace, envs, metadata, undefined, ['**/*.ts']), undefined);
    workspace.hasId = () => true;
    assert.equal(await prepareInstallRecords(workspace, envs, metadata), undefined);
  });
  it('resolves npm-style environment inheritance through pinned component dependencies', async () => {
    const { workspace, envs, metadata, version, envVersion, envId } = await fixture();
    const parentId = ComponentID.fromString('acme.envs/base@2.0.0');
    const childSource = new Source(Buffer.from(JSON.stringify({ extends: '@acme/envs.base', policy: {} })));
    const parentSource = new Source(
      Buffer.from(
        JSON.stringify({
          policy: { peers: [{ name: 'react', version: '18.0.0', supportedRange: '^18.0.0', override: true }] },
        })
      )
    );
    envVersion.files[0].file = childSource.hash();
    envVersion.extensions.findCoreExtension(DependencyResolverAspect.id).data.dependencies = [
      { packageName: '@acme/envs.base', componentId: parentId.serialize() },
    ];
    const parentVersion = { files: [{ relativePath: 'env.jsonc', file: parentSource.hash() }] };
    metadata.getVersion = async (requested) =>
      requested.isEqual(parentId) ? parentVersion : requested.isEqual(envId) ? envVersion : version;
    metadata.getSource = async (ref) =>
      ref.isEqual(childSource.hash()) ? childSource.contents : parentSource.contents;
    envs.mergeEnvManifests = (parent, child) => ({ policy: { ...parent.policy, ...child.policy } });
    const result = await prepareInstallRecords(workspace, envs, metadata);
    assert.ok(result);
    const peer = result.environments
      .get(envId.toString())!
      .policy.selfPolicy.entries.find((entry) => entry.dependencyId === 'react');
    assert.equal(peer?.value.version, '18.0.0');
  });

  it('falls back for newly registered policies even when the published snapshot had none', async () => {
    const { workspace, envs, metadata } = await fixture();
    assert.equal(await prepareInstallRecords(workspace, envs, metadata, undefined, [], () => true), undefined);
  });
});
