import assert from 'node:assert/strict';
import { ObjectsReadableGenerator } from './objects-readable-generator';

describe('installation metadata stream', () => {
  function fixture() {
    const ref = (name: string) => ({ toString: () => name, isEqual: () => false });
    const item = (name: string) => ({ ref: ref(name), buffer: Buffer.from(name), type: name });
    const version = {
      hash: () => ref('version'),
      asRaw: async () => Buffer.from('version'),
      getType: () => 'Version',
      files: [
        { relativePath: 'index.ts', file: ref('source') },
        { relativePath: 'env.jsonc', file: ref('env') },
      ],
      flattenedEdgesRef: ref('edges'),
      dependenciesGraphRef: ref('graph'),
      refsWithOptions: () => ['source', 'env', 'edges', 'graph', 'artifact'].map(ref),
      collectManyObjects: async (_repo: unknown, refs: Array<{ toString: () => string }>) =>
        refs.map((r) => item(r.toString())),
    };
    const component = {
      hash: () => ref('component'),
      asRaw: async () => Buffer.from('component'),
      getType: () => 'Component',
      loadVersion: async () => version,
    };
    const repo = { getScopeMetaObject: async () => item('scope') };
    const generator = new ObjectsReadableGenerator(repo as any, () => {});
    return { generator, component };
  }

  it('sends dependency metadata and env policy without fetching files, artifacts or parents', async () => {
    const { generator, component } = fixture();
    const producing = generator.pushObjectsToReadable(
      [
        { component, version: '1.0.0', collectParents: true, collectArtifacts: true, includeVersionHistory: true },
      ] as any,
      true
    );
    const received: string[] = [];
    for await (const object of generator.readable) received.push(object.ref.toString());
    await producing;
    assert.deepEqual(received, ['scope', 'component', 'version', 'edges', 'graph', 'env']);
  });

  it('preserves the complete payload for ordinary fetches', async () => {
    const { generator, component } = fixture();
    const producing = generator.pushObjectsToReadable([
      { component, version: '1.0.0', collectParents: false, collectArtifacts: true },
    ] as any);
    const received: string[] = [];
    for await (const object of generator.readable) received.push(object.ref.toString());
    await producing;
    assert.deepEqual(received, ['scope', 'component', 'source', 'env', 'edges', 'graph', 'artifact', 'version']);
  });
});
