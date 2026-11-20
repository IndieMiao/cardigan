import { lstatSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { Socket } from 'node:net';
import { createServer, version } from 'vite';

const host = '127.0.0.1';
const port = Number(process.argv[1]);
const listenHandle = process.argv[2] === undefined ? null : { fd: Number(process.argv[2]) };
const firstFd = process.argv[3] === undefined ? null : Number(process.argv[3]);
// Preserve the existing server mode. These settings describe the main HTTP
// endpoint only; they do not establish custody over the project Node process.
const managedHttp = version === '8.3.5' && ['js', 'mjs', 'ts', 'cjs', 'mts', 'cts'].every(ext => {
  try { return !lstatSync(`vite.config.${ext}`, { throwIfNoEntry: false }); }
  catch { return false; }
});
const vite = await createServer({
  ...(managedHttp ? { configFile: false, devtools: false } : {}),
  server: { host, port, strictPort: true, open: false, hmr: false,
    ...(managedHttp ? { ws: false, middlewareMode: true } : {}) },
});
// Socket activation hands over both the original listener and its first
// accepted connection. Do not proxy, probe, drop the first request, or race
// another process for the port. These descriptors confer no shutdown power.
function serveFirst(server) {
  if (firstFd !== null) server.once('listening', () => {
    server.emit('connection', new Socket({ fd: firstFd, readable: true, writable: true }));
  });
}
if (managedHttp) {
  const ingress = createHttpServer(vite.middlewares);
  await new Promise((resolve, reject) => {
    ingress.once('error', reject);
    serveFirst(ingress);
    if (listenHandle) ingress.listen(listenHandle, resolve);
    else ingress.listen(port, host, resolve);
  });
  console.log(`  Local: http://${host}:${ingress.address().port}/`);
} else {
  if (listenHandle) {
    // Preserve Vite's normal listen/initialization hooks and configured HTTP(S)
    // server. Substitute the already-bound handle for its first bind only.
    const server = vite.httpServer;
    const listen = server.listen;
    server.listen = function (...args) {
      server.listen = listen;
      serveFirst(server);
      const cb = args.at(-1);
      return listen.call(this, listenHandle, ...(typeof cb === 'function' ? [cb] : []));
    };
  }
  await vite.listen();
  vite.printUrls();
}
