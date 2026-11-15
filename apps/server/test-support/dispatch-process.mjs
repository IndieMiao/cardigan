import { loadCommandState } from "@cardigan/mcp-server";
import { Store, unfinishedBellAttempts } from "@cardigan/store";
import { Dispatcher } from "../dist/dispatch.js";

const [dataDir, project, now, mode, lateAttempt] = process.argv.slice(2);
const clock = { now: () => now };
const store = Store.open({ dataDir, clock });
const report = (message) =>
  new Promise((resolve, reject) =>
    process.send(message, (error) => (error ? reject(error) : resolve())),
  );
let calls = 0;
try {
  const dispatcher = new Dispatcher({
    store,
    clock,
    deliveryLeaseMs: 2000,
    snapshot: async () => {
      throw new Error("unexpected snapshot");
    },
    startRun: async () => {
      throw new Error("unexpected replacement");
    },
    runtime: {
      status: async () => ({
        ok: true,
        value: { process: "alive", agent: "idle", observed_seq: 1 },
      }),
      wake: async () => {
        calls++;
        if (mode !== "hold") throw new Error("recovery must not wake twice");
        await report({
          phase: "wake",
          intents: unfinishedBellAttempts(store.database, project).length,
        });
        await new Promise((resolve) => setTimeout(resolve, 60000)); // Parent kills us inside external IO.
        return { ok: true, value: { sent: true } };
      },
    },
  });
  if (mode === "late-success") {
    // Test-only access to the normal result settlement boundary: the original
    // owner is already dead, but an external response may carry its attempt.
    // Do not mutate the persisted outcome or release any mutex to fake exit.
    dispatcher.settle(JSON.parse(lateAttempt), true, "late_success");
  } else await dispatcher.tick();
  const state = store.uow.read((tx) => loadCommandState(tx, project));
  await report({
    phase: "recovered",
    calls,
    runs: state.runs.map((r) => ({ id: r.id, status: r.status })),
    notes: store.listNotifications({ project_id: project }).map((n) => ({
      id: n.id,
      status: n.status,
      recipient: n.recipient.kind,
    })),
    failures: state.events.filter((e) => e.type === "bell_delivery_failed")
      .length,
    intents: unfinishedBellAttempts(store.database, project).length,
  });
} finally {
  store.close();
  process.disconnect();
}
