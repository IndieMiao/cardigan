import { lstatSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { createServer, version } from 'vite';

const host = '127.0.0.1';
const port = Number(process.argv[1]);
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
if (managedHttp) {
  const ingress = createHttpServer(vite.middlewares);
  await new Promise((resolve, reject) => {
    ingress.once('error', reject);
    ingress.listen(port, host, resolve);
  });
  console.log(`  Local: http://${host}:${ingress.address().port}/`);
} else {
  await vite.listen();
  vite.printUrls();
}
