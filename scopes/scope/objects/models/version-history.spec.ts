import { expect } from 'chai';
import VersionHistory from './version-history';
import Ref from '../objects/ref';

const ref = (value: number) => new Ref(value.toString(16).padStart(40, '0'));

describe('VersionHistory.merge', () => {
  it('takes incoming parents and preserves incoming-first order, Ref identity and local graph state', () => {
    const previous = { hash: ref(1), parents: [ref(2)] };
    const localOnly = { hash: ref(2), parents: [], squashed: [ref(3)], unrelated: ref(4) };
    const incoming = { hash: ref(1), parents: [ref(5)], squashed: [], unrelated: ref(6) };
    const remoteOnly = { hash: ref(7), parents: [ref(1)] };
    const local = new VersionHistory({
      name: 'local',
      scope: 'local-scope',
      versions: [previous, localOnly],
      graphCompleteRefs: [ref(2).toString()],
    });
    const remote = new VersionHistory({
      name: 'remote',
      scope: 'remote-scope',
      versions: [remoteOnly, incoming],
      graphCompleteRefs: [ref(7).toString()],
    });
    local.merge(remote);
    expect(local.versions).to.deep.equal([remoteOnly, incoming, localOnly]);
    expect(local.getVersionData(ref(1))).to.equal(incoming);
    expect(local.getVersionData(ref(2))).to.equal(localOnly);
    expect(local.name).to.equal('local');
    expect(local.scope).to.equal('local-scope');
    expect(local.graphCompleteRefs).to.deep.equal([ref(2).toString()]);
    expect(local.hasChanged).to.equal(false);
    expect(remote.versions).to.deep.equal([remoteOnly, incoming]);
  });

  it('preserves last-value/first-position duplicate handling and supports empty and self merges', () => {
    const first = { hash: ref(1), parents: [] };
    const last = { hash: ref(1), parents: [ref(2)] };
    const middle = { hash: ref(2), parents: [] };
    const local = VersionHistory.create('component', 'scope', [first, middle, last]);
    expect(local.versions).to.deep.equal([last, middle]);
    local.merge(VersionHistory.create('component', 'scope', []));
    local.merge(local);
    expect(local.versions).to.deep.equal([last, middle]);
    expect(local.getAllHashesFrom(ref(1)).missing).to.deep.equal([]);
  });

  it('uses the stored hash keys when a shared Ref changes after construction', () => {
    const mutableRef = ref(1);
    const local = VersionHistory.create('component', 'scope', [{ hash: mutableRef, parents: [] }]);
    mutableRef.hash = ref(2).hash;
    local.merge(VersionHistory.create('component', 'scope', []));
    expect(local.versions).to.deep.equal([]);
  });
});
