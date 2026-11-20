import { DatabaseSync } from "node:sqlite";
import { parentPort, workerData } from "node:worker_threads";
import { WSClient } from "@larksuiteoapi/node-sdk";
import { feishuDispatcher } from "./feishu-dispatcher.js";
import { type AppCredential, feishuInbox } from "./feishu-inbox.js";
import { privateSdkHttp, privateSdkLogger } from "./feishu-sdk.js";

// No HTTP listener. Keep ACKs independent of slow reducers on the server's main thread.
const port = parentPort;
if (!port) throw new Error("Worker port required");
const { credential: c, path } = workerData as {
  credential: AppCredential;
  path: string;
};
const db = new DatabaseSync(path);
db.exec("PRAGMA busy_timeout=100");
const ws = new WSClient({
  appId: c.app_id,
  appSecret: c.app_secret,
  autoReconnect: true,
  handshakeTimeoutMs: 10_000,
  httpInstance: privateSdkHttp(10_000),
  logger: privateSdkLogger,
});
const status = () =>
  port.postMessage({ state: ws.getConnectionStatus().state });
const timer = setInterval(status, 5000);
port.once("message", () => {
  clearInterval(timer);
  ws.close({ force: true });
  db.close();
  port.close();
});
void ws
  .start({
    eventDispatcher: feishuDispatcher(
      feishuInbox(db, c, (job) => port.postMessage({ job })),
    ),
  })
  .then(status, () => port.postMessage({ state: "failed" }));
