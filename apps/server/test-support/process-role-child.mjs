// Isolated lifecycle fixture: real application assembly/SQLite/listeners, fake external IO.
import { Store } from "@cardigan/store";
import { stubGit } from "../dist/git-test-support.js";
import { startCardiganServer } from "../dist/server.js";
import { resolveWebConfig } from "../dist/web/config.js";

const [role, dataDir, mcpPort, webPort] = process.argv.slice(2);
const store = Store.open({ dataDir });
let release;
const held = new Promise((resolve) => {
  release = resolve;
});
const git = stubGit({
  project: { project_id: "fixture", source_repo: dataDir, base_branch: "main" },
  reconcile: async () => {
    if (store.database.isTransaction) throw new Error("IO inside transaction");
    process.send({ type: "reconciling" });
    await held;
    return [{ kind: "missing_worktree", detail: "synthetic finding" }];
  },
});
const runtime = {
  async status() {
    return {
      ok: true,
      value: { process: "alive", agent: "idle", observed_seq: 1 },
    };
  },
  async wake() {
    throw new Error("No live agents in this fixture");
  },
  async provision() {
    throw new Error("No live agents in this fixture");
  },
  async release() {
    return { ok: true, value: undefined };
  },
  async interrupt() {
    return { ok: true, value: undefined };
  },
  async resume_or_replace() {
    throw new Error("No live agents in this fixture");
  },
  async human_entry() {
    return { ok: true, value: "fixture" };
  },
  async *events() {},
};
let server;
try {
  server = await startCardiganServer({
    role,
    store,
    git,
    env: { CARDIGAN_CONFIG_DIR: dataDir, CARDIGAN_RUNTIME_MODE: "local" },
    config: { dataDir, host: "127.0.0.1", port: Number(mcpPort) },
    web: {
      config: resolveWebConfig(
        {},
        { port: Number(webPort), staticDir: dataDir },
      ),
    },
    dispatcher: {
      runtime,
      snapshot: async () => ({}),
      startRun: async () => {
        throw new Error("No launches");
      },
    },
    log: () => {},
    warn: () => {},
  });
  process.send({
    type: "ready",
    role,
    url: server.url,
    web_url: server.web?.url,
  });
} catch {
  store.close();
  process.send({ type: "failed" });
  process.exit(1);
}
process.on("message", async (message) => {
  if (message === "release") release();
  if (message === "stop") {
    process.send({ type: "stopping" });
    await server.close();
    store.close();
    process.exit(0);
  }
});
process.once("disconnect", () => process.exit(1));
