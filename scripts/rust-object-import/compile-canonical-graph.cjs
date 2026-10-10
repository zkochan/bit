// BVM's Windows link is a directory, rather than a POSIX executable shim on PATH.
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const windows = process.platform === 'win32';
const executable = windows ? process.execPath : 'bbit';
const prefix = windows ? [path.join(process.env.LOCALAPPDATA, '.bvm', 'bbit', 'bin', 'bit.js')] : [];
if (windows && !fs.statSync(prefix[0]).isFile()) throw new Error('missing BVM canonical Bit CLI');
for (const args of [
  ['config', 'set', 'analytics_reporting', 'false'],
  ['config', 'set', 'error_reporting', 'false'],
  ['config', 'set', 'registry', 'https://node-registry.bit.cloud'],
  ['init'],
  ['install'],
  ['compile', 'teambit.legacy/scope', 'teambit.scope/objects', 'teambit.scope/network', 'teambit.scope/scope'],
])
  cp.execFileSync(executable, [...prefix, ...args], { stdio: 'inherit' });
