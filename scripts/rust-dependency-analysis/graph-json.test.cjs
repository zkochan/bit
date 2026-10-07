const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const installedRoot = process.env.BIT_LEGACY_ROOT || path.resolve(__dirname, '../..');
const installed = Module.createRequire(path.join(installedRoot, 'package.json'));
const ts = installed('typescript');
require.extensions['.ts'] = (target, filename) => {
  target.paths = [...Module._nodeModulePaths(installedRoot), ...target.paths];
  target._compile(
    ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
      fileName: filename,
    }).outputText,
    filename
  );
};
const { GraphCmd } = require('../../scopes/component/graph/graph-cmd.ts');
const { Graph, Node, Edge } = installed('@teambit/graph.cleargraph');
const GraphLib = installed('graphlib');
const ids = ['scope/z@1', 'scope/A@1', 'scope/a@2', 'scope/a@1'];
const edges = [
  ['scope/z@1', 'scope/a@1', 'prod', false],
  ['scope/A@1', 'scope/z@1', 'ext', true],
  ['scope/a@1', 'scope/A@1', 'dev', false],
  ['scope/a@2', 'scope/z@1', 'peer', false],
];
function makeGraph(reverse = false) {
  const order = (items) => (reverse ? [...items].reverse() : items);
  return new Graph(
    order(ids).map((id) => new Node(id, { originalId: id })),
    order(edges).map(([source, target, attr, bidirectional]) => new Edge(source, target, attr, bidirectional))
  );
}
function command(graph, localIds = ids) {
  const calls = [];
  const host = {
    resolveComponentId: async (id) => {
      calls.push(id);
      return { toString: () => id };
    },
    listIds: async () => localIds.map((id) => ({ toString: () => id })),
  };
  return {
    calls,
    cmd: new GraphCmd({ getHost: () => host }, { getGraphIds: async () => graph }),
  };
}
test('local graph JSON has identical bytes for shuffled discovery order and retains every edge field', async () => {
  const graph = makeGraph();
  const reversed = makeGraph(true);
  const original = JSON.stringify(graph.toJson());
  assert.notEqual(original, JSON.stringify(reversed.toJson()));
  const left = await command(graph).cmd.json([undefined], { includeDependencies: true });
  const right = await command(reversed).cmd.json([undefined], { includeDependencies: true });
  assert.equal(JSON.stringify(left), JSON.stringify(right));
  assert.deepEqual(left.nodes, [...ids].sort());
  assert.deepEqual(
    left.edges,
    graph
      .toJson()
      .edges.slice()
      .sort((a, b) => (a.id < b.id ? -1 : 1))
  );
  assert.deepEqual(left.edges.map((edge) => edge.attr).sort(), ['dev', 'ext', 'peer', 'prod']);
  assert.ok(left.edges.some((edge) => edge.bidirectional));
  assert.equal(JSON.stringify(graph.toJson()), original, 'CLI serialization must not reorder the internal graph');
});
test('default local-only filtering keeps its exact node and edge membership with stable bytes', async () => {
  const local = ['scope/z@1', 'scope/A@1'];
  const left = await command(makeGraph(), local).cmd.json([undefined], {});
  const right = await command(makeGraph(true), local).cmd.json([undefined], {});
  assert.equal(JSON.stringify(left), JSON.stringify(right));
  assert.deepEqual(left.nodes, [...local].sort());
  assert.equal(left.edges.length, 1);
  assert.deepEqual(
    left.edges[0],
    makeGraph()
      .toJson()
      .edges.find((edge) => edge.attr === 'ext')
  );
});
test('explicit component resolution and includeLocalOnly=false retain existing behavior', async () => {
  const { cmd, calls } = command(makeGraph(), []);
  const result = await cmd.json(['scope/z@1'], { includeLocalOnly: false });
  assert.deepEqual(calls, ['scope/z@1']);
  assert.equal(result.nodes.length, 4);
  assert.equal(result.edges.length, 4);
});
test('remote graphlib JSON retains its distinct schema, labels, names, and graph options', async () => {
  const graph = new GraphLib.Graph({ directed: true, multigraph: true, compound: true });
  graph.setGraph({ layout: 'dot', label: 'remote' });
  graph.setNode('z', { label: 'Z' });
  graph.setNode('a', { label: 'A' });
  graph.setEdge('z', 'a', { dependencyType: 'peer' }, 'named-edge');
  const { cmd } = command(makeGraph());
  cmd.generateGraphFromRemote = async () => graph;
  assert.deepEqual(await cmd.json([undefined], { remote: 'scope' }), GraphLib.json.write(graph));
});
