// This process owns one registration. Replies can only explain retention;
// they do not grant the supervisor any authority to stop another process.
import { lstatSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { Socket } from 'node:net';
import { createServer, version } from 'vite';

const control = new Socket({ fd: Number(process.env.CARDIGAN_PRIVATE_LIFETIME_FD) });
delete process.env.CARDIGAN_PRIVATE_LIFETIME_FD;
control.on('error', () => { /* Losing the capability is not settlement. */ });

const host = '127.0.0.1';
const port = Number(process.argv[1]);
// Run configured projects normally, but do not claim to observe listeners
// created by their config or plugins. Pin configFile:false on the proven path:
// a config appearing after this decision must not silently introduce an inlet.
const singleIngress = version === '8.3.5' && ['js', 'mjs', 'ts', 'cjs', 'mts', 'cts'].every(ext => {
  try { return !lstatSync(`vite.config.${ext}`, { throwIfNoEntry: false }); }
  catch { return false; }
});
const vite = await createServer({
  ...(singleIngress ? { configFile: false, devtools: false } : {}),
  server: { host, port, strictPort: true, open: false, hmr: false,
    ...(singleIngress ? { ws: false, middlewareMode: true } : {}) },
});
let ingress;
let admitted = false;
let observedFromStart = false;
if (singleIngress) {
  // Vite has no listener of its own in this mode. Our entry point stays the
  // same even if Vite reinitializes its middleware. Mark admission before HTTP
  // dispatch (including requests that never finish). Never reset on close.
  ingress = createHttpServer(vite.middlewares);
  observedFromStart = vite.httpServer === null && vite.config.server.ws === false &&
    vite.config.server.middlewareMode === true && vite.config.configFile === undefined;
  ingress.prependListener('connection', () => { admitted = true; });
  ingress.on('error', () => { observedFromStart = false; });
  ingress.once('close', () => { observedFromStart = false; });
  await new Promise((resolve, reject) => {
    ingress.once('error', reject);
    ingress.listen(port, host, resolve);
  });
  console.log(`  Local: http://${host}:${ingress.address().port}/`);
} else {
  await vite.listen();
  vite.printUrls();
}

const marker = Buffer.from('cardigan-private-settled-v1\n');
let offset = 0;
control.on('data', block => {
  if (!marker.subarray(offset, offset + block.length).equals(block)) { control.destroy(); return; }
  offset += block.length;
  if (offset !== marker.length) return;
  control.pause();
  if (!observedFromStart || !ingress?.listening) { control.end('?'); return; }
  if (admitted) { control.end('U'); return; }
  // First admission and this fence run on the same event loop, with no await
  // in between. Do not tear down middleware until the sole listener is closed.
  ingress.close(error => {
    if (error || admitted) { control.end('?'); return; }
    void vite.close().then(() => control.destroy(), () => control.end('?'));
  });
});
