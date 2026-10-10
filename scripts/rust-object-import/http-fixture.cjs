// Loopback server using Bit's compiled FetchRoute and tar-stream encoder.
const http = require('node:http');
const path = require('node:path');
const { createRequire } = require('node:module');
const load = createRequire(path.join(process.argv[2], 'package.json'));
const { FetchRoute } = load('@teambit/scope/dist/routes/fetch.route.js');
const scopes = JSON.parse(process.argv[3]);
const servers = [];
const failures = process.argv[5] ? JSON.parse(process.argv[5]) : [];
const gates = process.argv[4] ? JSON.parse(process.argv[4]) : {};
const delayMs = Number(process.env.BIT_IMPORT_QUALIFICATION_HTTP_DELAY_MS || 0);
if (!Number.isInteger(delayMs) || delayMs < 0 || delayMs > 5000) throw new Error('invalid controlled HTTP delay');
async function waitForHistory(markers) {
  const fs = require('node:fs/promises');
  const zlib = require('node:zlib');
  const started = Date.now();
  for (;;) {
    const complete = await Promise.all(
      markers.map(async ({ filename, marker }) => {
        try {
          const bytes = zlib.inflateSync(await fs.readFile(filename));
          if (!marker) return true;
          const body = JSON.parse(bytes.subarray(bytes.indexOf(0) + 1));
          return body.versions.some((entry) => entry.hash === marker);
        } catch {
          return false;
        }
      })
    );
    if (complete.every(Boolean)) return;
    if (Date.now() - started > 10000) throw new Error('history persistence gate timed out');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
(async () => {
  const remotes = {};
  for (const [name, remote] of Object.entries(scopes)) {
    const route = new FetchRoute(
      {
        path: remote.slice('file://'.length),
        name,
        config: { httpTimeOut: 120000 },
        preFetchObjects: { values: () => [] },
      },
      { info() {}, warn() {}, error() {} }
    );
    const server = http.createServer(async (req, res) => {
      if (req.method !== 'POST' || req.url !== '/api/scope/fetch') {
        res.writeHead(404);
        res.end();
        return;
      }
      try {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        req.body = JSON.parse(Buffer.concat(chunks).toString());
        if (gates[name]) {
          await waitForHistory(gates[name]);
          process.send?.({ gateReleased: name });
        }
        if (failures.includes(name)) {
          const pack = load('tar-stream').pack();
          pack.entry({ name: '.BIT.START' }, Buffer.from(JSON.stringify({ schema: '1.0.0', scopeName: name })));
          pack.finalize();
          const chunks = [];
          for await (const chunk of pack) chunks.push(chunk);
          res.writeHead(200);
          res.write(Buffer.concat(chunks).subarray(0, 1024));
          process.send?.({ interruptedRemote: name });
          setTimeout(() => res.destroy(), 20);
          return;
        }
        if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
        await route.middlewares[0](req, res);
      } catch (error) {
        if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ message: error.message }));
      }
    });
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    servers.push(server);
    remotes[name] = `http://127.0.0.1:${server.address().port}`;
  }
  process.send({ remotes });
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
process.on('disconnect', () => {
  for (const server of servers) server.close();
});
