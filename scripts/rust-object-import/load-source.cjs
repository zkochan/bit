const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const root = path.resolve(__dirname, '../..');
const installedRoot = process.env.BIT_LEGACY_ROOT || root;
const installed = Module.createRequire(path.join(installedRoot, 'package.json'));
const ts = installed('typescript');
require.extensions['.ts'] = (target, filename) => {
  target.paths = [...Module._nodeModulePaths(installedRoot), ...target.paths];
  const output = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
    fileName: filename,
  });
  target._compile(output.outputText, filename);
};
module.exports = { root, installedRoot, installed, source: (file) => require(path.join(root, file)) };
