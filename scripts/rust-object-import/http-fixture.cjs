// Loopback server using Bit's compiled FetchRoute and tar-stream encoder.
const http = require('node:http');
const path = require('node:path');
const { createRequire } = require('node:module');
const load = createRequire(path.join(process.argv[2], 'package.json'));
const { FetchRoute } = load('@teambit/scope/dist/routes/fetch.route.js');
const scopes = JSON.parse(process.argv[3]);
const servers = [];
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
