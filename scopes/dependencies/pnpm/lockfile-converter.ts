import { LockfileFileV9 } from '@pnpm/lockfile.types';
import * as dp from '@pnpm/dependency-path';
import { pick, partition } from 'lodash';
import { type DependenciesGraph } from '@teambit/legacy/dist/scope/models/version';

export function convertLockfileToGraph(lockfile: LockfileFileV9): Pick<DependenciesGraph, 'nodes' | 'edges'> {
  const nodes: any[] = [];
  const edges: any[] = [];
  for (const [depPath, snapshot] of Object.entries(lockfile.snapshots ?? {})) {
    const neighbours: Array<{ id: string; type: string }> = [];
    for (const { depTypeField, depType } of [
      { depTypeField: 'dependencies', depType: 'prod' },
      { depTypeField: 'optionalDependencies', depType: 'optional' },
    ]) {
      for (const [pkgName, ref] of Object.entries((snapshot[depTypeField] ?? {}) as Record<string, string>)) {
        const subDepPath = dp.refToRelative(ref, pkgName);
        if (subDepPath == null) continue;
        neighbours.push({ id: subDepPath, type: depType });
      }
    }
    const pkgId = dp.removeSuffix(depPath);
    const edge = {
      id: depPath,
      neighbours,
      attr: {
        pkgId,
      },
    } as any;
    if (snapshot.transitivePeerDependencies) {
      edge.attr.transitivePeerDependencies = snapshot.transitivePeerDependencies;
    }
    edges.push(edge);
    nodes.push({
      pkgId,
      attr: pick(lockfile.packages![pkgId], [
        'bundledDependencies',
        'cpu',
        'deprecated',
        'engines',
        'hasBin',
        'libc',
        'name',
        'os',
        'peerDependencies',
        'peerDependenciesMeta',
        'resolution',
        'version',
      ]),
    });
  }
  return { edges, nodes };
}

export function convertGraphToLockfile(graph: DependenciesGraph): LockfileFileV9 {
  const packages = {};
  const snapshots = {};
  for (const edge of graph.edges) {
    snapshots[edge.id] = {};
    packages[edge.attr.pkgId] = {};
    const [prodDeps, optionalDeps] = partition(edge.neighbours, (dep) => dep.type === 'prod');
    if (prodDeps.length) {
      snapshots[edge.id].dependencies = Object.fromEntries(
        prodDeps.map(({ id }) => {
          const parsed = dp.parse(id);
          return [parsed.name, `${parsed.version}${parsed.peersSuffix ?? ''}`]; // TODO: support peers
        })
      );
    }
    if (optionalDeps.length) {
      snapshots[edge.id].optionalDependencies = Object.fromEntries(
        optionalDeps.map(({ id }) => {
          const parsed = dp.parse(id);
          return [parsed.name, `${parsed.version}${parsed.peersSuffix ?? ''}`]; // TODO: support peers
        })
      );
    }
    const node = graph.nodes.find(({ pkgId }) => edge.attr.pkgId === pkgId);
    if (node) {
      Object.assign(
        packages[edge.attr.pkgId],
        pick(node.attr, [
          'bundledDependencies',
          'cpu',
          'deprecated',
          'engines',
          'hasBin',
          'libc',
          'name',
          'os',
          'peerDependencies',
          'peerDependenciesMeta',
          'resolution',
          'version',
        ])
      );
    }
  }
  return {
    lockfileVersion: '9.0',
    packages,
    snapshots,
  };
}