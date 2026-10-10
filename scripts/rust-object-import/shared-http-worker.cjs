const fs = require('node:fs/promises');
const path = require('node:path');
const { createRequire } = require('node:module');
const [cli, directory, manifestFile] = process.argv.slice(2);
const load = createRequire(path.join(cli, 'package.json'));
(async () => {
  const { Scope } = load('@teambit/legacy.scope');
  const { ObjectFetcher } = load('@teambit/legacy.scope/dist/objects-fetcher/objects-fetcher.js');
  const { getScopeRemotes } = load('@teambit/scope.remotes');
  const { ComponentID } = load('@teambit/component-id');
  const manifest = JSON.parse(await fs.readFile(manifestFile));
  const scope = await Scope.load(directory, false);
  const remotes = await getScopeRemotes(scope);
  const fetcher = new ObjectFetcher(
    scope.objects,
    scope,
    remotes,
    {
      type: 'component',
      allowExternal: true,
      includeVersionHistory: true,
      collectParents: true,
      includeArtifacts: false,
      returnNothingIfGivenVersionExists: false,
    },
    manifest.ids.map((id) => ComponentID.fromString(id)),
    undefined,
    undefined,
    true,
    manifest.groupedIds
  );
  const hashes = await fetcher.fetchFromRemoteAndWrite();
  console.log(JSON.stringify({ hashes }));
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
