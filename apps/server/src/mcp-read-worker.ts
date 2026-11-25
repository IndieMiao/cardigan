import { parentPort, workerData } from "node:worker_threads";
import { readProjectSnapshot, ToolError } from "@cardigan/mcp-server";
import { Store } from "@cardigan/store";
import type { McpReaderOptions, McpReadRequest } from "./mcp-reader.js";

const port = parentPort;
if (!port) throw new Error("MCP read worker requires its private parent port");
const options = workerData as McpReaderOptions;
// C-648: a private read-only connection; its command state cache never
// competes with the Web thread's event loop.
const store = Store.open({ dbPath: options.dbPath, migrate: false });
store.database.exec("PRAGMA query_only = ON");

port.on("message", (message: McpReadRequest | { kind: "close" }) => {
  if (message.kind === "close") {
    store.close();
    port.close();
    return;
  }
  if (message.kind !== "project_snapshot") return;
  const started = performance.now();
  try {
    const value = readProjectSnapshot(store, message.actor, message.input);
    port.postMessage({
      id: message.id,
      value,
      worker_ms: performance.now() - started,
    });
  } catch (error) {
    port.postMessage({
      id: message.id,
      error:
        error instanceof ToolError
          ? error.toDomainError()
          : { code: "validation_failed", message: "参考资料读取失败。" },
      worker_ms: performance.now() - started,
    });
  }
});
