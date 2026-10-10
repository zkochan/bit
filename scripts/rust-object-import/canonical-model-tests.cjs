// Run unchanged source specifications against the physical compiled graph, preserving cyclic module identities.
const path = require('node:path');
const Module = require('node:module');
const { root, installed, installedRoot } = require('./load-source.cjs');
const Mocha = installed('mocha');
const compiled = path.dirname(installed.resolve('@teambit/objects'));
const directories = [...new Set([root, installedRoot])].map((directory) =>
  path.join(directory, 'scopes/scope/objects')
);
const resolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
  const filename = resolve.call(this, request, parent, ...rest);
  for (const directory of directories) {
    if (filename.startsWith(directory + path.sep) && filename.endsWith('.ts') && !filename.endsWith('.spec.ts'))
      return path.join(compiled, path.relative(directory, filename).replace(/\.ts$/, '.js'));
  }
  return filename;
};
const mocha = new Mocha();
for (const file of [
  'models/model-component.spec.ts',
  'models/version.spec.ts',
  'models/version-history.spec.ts',
  'models/lane-history.spec.ts',
  'objects/scope-index.spec.ts',
])
  mocha.addFile(path.join(root, 'scopes/scope/objects', file));
mocha.loadFiles();
mocha.run((failures) => {
  process.exitCode = failures ? 1 : 0;
});
