// Executed only by the explicit private Vite entry, in the project that owns
// the installed Vite. This process is the sole reader of the lifetime record.
import { Socket } from 'node:net';
import { createServer } from 'vite';

const control = new Socket({ fd: Number(process.env.CARDIGAN_PRIVATE_LIFETIME_FD), readable: true, writable: false });
// Do not advertise a stale descriptor to plugin children. Only this owner
// manages the server object and its private plugin resources.
delete process.env.CARDIGAN_PRIVATE_LIFETIME_FD;
const server = await createServer({ server: { host: '127.0.0.1', port: Number(process.argv[1]), strictPort: true, hmr: false, open: false } });
const http = server.httpServer;
if (!http || http.listening) throw new Error('Private Vite listener unavailable');
const clients = new Set();
http.prependListener('connection', socket => {
  clients.add(socket);
  socket.once('close', () => clients.delete(socket));
});
await server.listen();
server.printUrls();
const marker = 'cardigan-private-settled-v1\n';
let received = '';
control.on('error', () => { /* Unknown is never a stop request. */ });
control.on('data', block => {
  received += block.toString('ascii');
  if (!marker.startsWith(received)) { control.destroy(); return; }
  if (received !== marker) return;
  control.pause();
  // Actual connections tracked from before listen(), not a /proc snapshot.
  // If a consumer is present leave admission and all clients untouched.
  if (clients.size) return;
  // Fence new accepts synchronously; finish Vite/plugin teardown only after
  // the listener itself confirms closure, never destroy a consumer socket.
  http.close(error => {
    if (error || clients.size) return;
    void server.close().then(() => control.destroy(), () => control.destroy());
  });
});
