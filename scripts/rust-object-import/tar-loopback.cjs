// Disposable authenticated fixture server, not Bit's production HTTP client.
const http = require('node:http');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { once } = require('node:events');
const { pipeline } = require('node:stream/promises');
async function openLoopbackArchive(archive) {
  const token = crypto.randomBytes(24).toString('hex');
  const size = (await fs.promises.stat(archive)).size;
  const server = http.createServer((request, response) => {
    if (request.method !== 'GET' || request.url !== '/archive' || request.headers.authorization !== `Bearer ${token}`) {
      response.writeHead(403).end();
      return;
    }
    response.writeHead(200, { 'Content-Length': size });
    pipeline(fs.createReadStream(archive), response).catch(() => response.destroy());
  });
  const close = () =>
    new Promise((resolve, reject) => {
      server.closeAllConnections();
      server.close((error) => (error ? reject(error) : resolve()));
    });
  try {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const stream = await new Promise((resolve, reject) => {
      const request = http.get(
        {
          host: '127.0.0.1',
          port: server.address().port,
          path: '/archive',
          headers: { Authorization: `Bearer ${token}` },
        },
        (response) => {
          if (response.statusCode === 200) resolve(response);
          else {
            response.destroy();
            reject(new Error(`loopback HTTP status ${response.statusCode}`));
          }
        }
      );
      request.on('error', reject);
    });
    return { stream, close };
  } catch (error) {
    if (server.listening) await close();
    throw error;
  }
}
module.exports = { openLoopbackArchive };
