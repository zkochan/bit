// Install validation only: observe the real engine call without replacing it or logging credentials.
require('./command-trace.cjs');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const load = createRequire(path.join(process.cwd(), 'package.json'));
const api = load('@pnpm/napi');
const install = api.install;
const calls = [];
api.install = function (options, ...rest) {
  for (const key of ['storeDir', 'cacheDir']) {
    const root = process.env.BIT_INSTALL_VALIDATION_ROOT;
    if (!options[key] || !path.resolve(options[key]).startsWith(root + path.sep))
      throw new Error(`install validation refuses external ${key}: ${options[key]}`);
  }
  // Registry/auth/proxy options are deliberately excluded from the report.
  calls.push({
    projects: JSON.parse(JSON.stringify(options.projects)),
    storeDir: options.storeDir,
    cacheDir: options.cacheDir,
    lockfileOnly: options.lockfileOnly,
    offline: options.offline ?? false,
  });
  return install.call(this, options, ...rest);
};
process.on('exit', () => {
  if (process.env.BIT_INSTALL_VALIDATION_TRACE)
    fs.writeFileSync(process.env.BIT_INSTALL_VALIDATION_TRACE, JSON.stringify(calls));
});
