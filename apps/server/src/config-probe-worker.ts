import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { DEFAULT_MCP_HOST } from "./config.js";
import { startCardiganServer } from "./server.js";

/** Trusted installed code only. No dispatcher, Web listener, runtime or Git work. */
export async function configProbeSmoke(root: string): Promise<void> {
  const dataDir = join(root, "data");
  const options = {
    env: {
      CARDIGAN_CONFIG_DIR: join(root, "config"),
      CARDIGAN_DATA_DIR: dataDir,
      CARDIGAN_RUNTIME_MODE: "local",
    },
    config: {
      dataDir,
      host: DEFAULT_MCP_HOST,
      port: 0,
      execution: { mode: "local" as const, dataDir },
    },
    log: () => {},
    warn: () => {},
  };
  const first = await startCardiganServer(options);
  try {
    if (
      !first.port ||
      first.host !== DEFAULT_MCP_HOST ||
      first.store.listProjects().length
    )
      throw new Error("Isolation failed");
    first.store.createProject({ id: "probe-fixture" });
    if (
      first.store.database.prepare("PRAGMA journal_mode").get()
        ?.journal_mode !== "wal"
    )
      throw new Error("Migration failed");
  } finally {
    await first.close();
  }
  // Restart the isolated service against its own migrated database, as after a deploy.
  const second = await startCardiganServer(options);
  try {
    if (
      second.store.listProjects().length !== 1 ||
      second.store.listProjects()[0]?.id !== "probe-fixture"
    )
      throw new Error("Restart failed");
  } finally {
    await second.close();
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  // The host owns the IPC pipe. A lost parent cannot leave a listening child behind.
  process.once("disconnect", () => process.exit(1));
  if (!process.connected) process.exit(1);
  process.once("message", (message: unknown) => {
    void (async () => {
      try {
        const root = process.env.CARDIGAN_PROBE_ROOT;
        if (message !== "start" || !root || !process.send || !process.connected)
          throw new Error("Missing host context");
        await configProbeSmoke(root);
        process.send("passed", () => process.exit(0));
      } catch {
        process.exit(1);
      }
    })();
  });
}
