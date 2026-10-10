// Sample only the owning CLI; forked analytics/helper processes must not overwrite its profile.
const fs = require('node:fs');
const path = require('node:path');
const inspector = require('node:inspector');
const output = process.env.BIT_IMPORT_CPU_PROFILE;
process.env.BIT_IMPORT_CPU_PROFILE_OWNER ??= String(process.pid);
if (output && Number(process.env.BIT_IMPORT_CPU_PROFILE_OWNER) === process.pid) {
  fs.mkdirSync(path.dirname(output), { recursive: true });
  const session = new inspector.Session();
  session.connect();
  const post = (method, params, callback) =>
    session.post(method, params, (error, result) => {
      if (error) throw error;
      callback?.(result);
    });
  post('Profiler.enable');
  post('Profiler.setSamplingInterval', { interval: 1000 });
  post('Profiler.start');
  process.once('exit', () => {
    post('Profiler.stop', {}, ({ profile }) => fs.writeFileSync(output, JSON.stringify(profile)));
    session.disconnect();
  });
}
