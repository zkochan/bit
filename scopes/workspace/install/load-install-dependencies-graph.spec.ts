import assert from 'node:assert/strict';
import { ComponentID } from '@teambit/component-id';
import { DependenciesGraph, Ref } from '@teambit/objects';
import { loadInstallDependenciesGraph } from './load-install-dependencies-graph';
import { InstallMain } from './install.main.runtime';

const ids = ['button', 'icon'].map((name) => ComponentID.fromString(`acme.ui/${name}@1.0.0`));
function graph(name: string) {
  return new DependenciesGraph({
    packages: new Map([[`${name}@1.0.0`, { resolution: { integrity: 'sha512-test' } }]]),
    edges: [{ id: '.', neighbours: [{ id: `${name}@1.0.0`, name, specifier: '^1.0.0' }] }],
  });
}
function metadata(sources: Array<string | undefined>) {
  return {
    getVersion: async (id) => ({ dependenciesGraphRef: new Ref(String(ids.indexOf(id))) }),
    getSource: async (ref) =>
      sources[Number(ref.toString())] === undefined ? undefined : Buffer.from(sources[Number(ref.toString())]!),
    load: async () => {
      throw new Error('must not fetch source bodies');
    },
  } as any;
}

describe('detached installation dependency graphs', () => {
  it('merges graph sources before import without mutating the inputs or cached Version graphs', async () => {
    const first = graph('react');
    const second = graph('lodash');
    const inputs = [first.serialize(), second.serialize()];
    const data = metadata(inputs);
    const loadVersion = data.getVersion;
    data.getVersion = async (id) => ({ ...(await loadVersion(id)), _dependenciesGraph: first });
    const merged = await loadInstallDependenciesGraph(ids, data);
    assert.deepEqual([...merged!.packages.keys()].sort(), ['lodash@1.0.0', 'react@1.0.0']);
    assert.equal(first.serialize(), inputs[0]);
    assert.equal(second.serialize(), inputs[1]);
  });

  it('ignores absent, empty and unsupported graphs, preserving missing-graph fallback', async () => {
    assert.equal(
      await loadInstallDependenciesGraph(ids, metadata([undefined, JSON.stringify({ schemaVersion: 'future' })])),
      undefined
    );
    const empty = new DependenciesGraph({ packages: new Map(), edges: [] });
    assert.equal(await loadInstallDependenciesGraph(ids, metadata([empty.serialize()])), undefined);
    const result = await loadInstallDependenciesGraph(ids, metadata([undefined, graph('react').serialize()]));
    assert.equal(result!.packages.size, 1);
  });

  it('propagates malformed graphs and storage failures', async () => {
    await assert.rejects(loadInstallDependenciesGraph(ids, metadata(['invalid json'])), SyntaxError);
    const data = metadata([]);
    const error = new Error('read failed');
    data.getSource = async () => {
      throw error;
    };
    await assert.rejects(loadInstallDependenciesGraph(ids, data), (err) => err === error);
  });

  it('resolves --restore from metadata and preserves explicit graph precedence', async () => {
    const install = Object.assign(Object.create(InstallMain.prototype), {
      workspace: {
        listIds: () => ids,
        scope: {
          getDependenciesGraphByComponentIds: () => {
            throw new Error('must not read incomplete scope');
          },
        },
      },
      logger: { console: () => {} },
    });
    const context = { hasRootComponents: true, metadata: metadata([graph('react').serialize()]) };
    assert.equal(
      (await install.resolveDependenciesGraph({ restoreFromDependenciesGraph: true }, context)).packages.size,
      1
    );
    const explicit = graph('lodash');
    assert.equal(await install.resolveDependenciesGraph({ dependenciesGraph: explicit }, context), explicit);
    assert.equal(await install.resolveDependenciesGraph({}, context), undefined);
  });
});
