const fs = require('fs-extra');
const globby = require('globby');
const { parse, stringify } = require('comment-json');
const pkgJson = require('../package.json');
const allDeps = [...Object.keys(pkgJson.dependencies), ...Object.keys(pkgJson.devDependencies)];

const workspaceJson = fs.readFileSync(`${__dirname}/../workspace.jsonc`, 'utf8');
const workspaceJsonParsed = parse(workspaceJson);
const policy = workspaceJsonParsed['teambit.dependencies/dependency-resolver'].policy;
const workspacePackages = [...Object.keys(policy.dependencies), ...Object.keys(policy.peerDependencies)];
const sourceCode = ['src', 'scopes', 'e2e', 'components'];
const sourceCodeAbs = sourceCode.map((dir) => `${__dirname}/../${dir}`);
const sourceFiles = globby.sync(sourceCodeAbs, {
  ignore: ['**/node_modules/**'],
});

let unused = [...allDeps];
let unusedWorkspace = [...workspacePackages];
const used = [];

// these are not mentioned in the code, but still needed
const whitelist = [
  'pino-pretty', // needed for the logger. (although it has no import/require in the code)
  'regenerator-runtime',
  'babel-plugin-ramda',
  'eslint-plugin-mocha',
  'eslint-plugin-promise',
  'eslint-plugin-import',
  'eslint-plugin-react',
  'eslint-import-resolver-node',
  'lint-staged',
  'mocha-circleci-reporter',
  'mocha-junit-reporter',
  'prettier-eslint',
  'type-coverage',
  '@yarnpkg/plugin-pack',
  'graceful-fs', // might be used as a peer by other stuff
  'mz', // needs to check what happens if gets removed.
  'npm', // needed for e2e tests
  'cross-env', // needed for e2e tests on Windows
  '@typescript-eslint/typescript-estree', // required for @typescript-eslint/parser in .eslintrc.js
  '@mdx-js/mdx', // required for @mdx-js/react in mdx files - maybe should be added to envs (like we have in env.jsonc)
  // then we can remove it from here
  'mocha-multi-reporters',
];
used.push(...whitelist);
unused = unused.filter((dep) => !whitelist.includes(dep));
unusedWorkspace = unusedWorkspace.filter((dep) => !whitelist.includes(dep));

const isDepUsed = (content, dep) =>
  content.includes(`'${dep}'`) ||
  content.includes(`"${dep}"`) ||
  content.includes(`'${dep}/`) ||
  content.includes(`"${dep}/`);

sourceFiles.forEach((file) => {
  const content = fs.readFileSync(file, 'utf8');
  unused.forEach((dep) => {
    if (isDepUsed(content, dep)) {
      console.log('! found ', dep);
      unused = unused.filter((d) => d !== dep);
      used.push(dep);
    }
  });
  unusedWorkspace.forEach((dep) => {
    if (isDepUsed(content, dep)) {
      console.log('! found ', dep);
      unusedWorkspace = unusedWorkspace.filter((d) => d !== dep);
      used.push(dep);
    }
  });
});

unused.forEach((dep) => {
  if (dep.startsWith('@types/')) {
    const pkg = dep.replace('@types/', '');
    if (used.includes(pkg)) {
      unused = unused.filter((d) => d !== dep);
      used.push(dep);
    }
  }
});
unusedWorkspace.forEach((dep) => {
  if (dep.startsWith('@types/')) {
    const pkg = dep.replace('@types/', '');
    if (used.includes(pkg)) {
      unusedWorkspace = unusedWorkspace.filter((d) => d !== dep);
      used.push(dep);
    }
  }
});

console.log('[-] unused packages in package.json', unused);
console.log('[-] unused packages in workspace.jsonc', unusedWorkspace);
console.log('[-] total packages', allDeps.length + workspacePackages.length);
console.log('[-] total packages in use:', used.length);
console.log('[-] total packages in package.json not in use:', unused.length);
console.log('[-] total packages in workspace.jsonc not in use:', unusedWorkspace.length);

function deleteUnusedFromWorkspaceJsonc() {
  unusedWorkspace.forEach((dep) => {
    delete policy.dependencies[dep];
    delete policy.peerDependencies[dep];
  });
  fs.writeFileSync(`${__dirname}/../workspace.jsonc`, stringify(workspaceJsonParsed, null, 2));
}

// check whether "delete" was added to the command line arguments
const deleteUnused = process.argv.includes('delete');
if (deleteUnused) {
  deleteUnusedFromWorkspaceJsonc();
}
