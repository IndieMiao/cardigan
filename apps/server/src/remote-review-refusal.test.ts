import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  Machine,
  Runtime,
  RuntimeRef,
  RuntimeResult,
} from "@cardigan/domain";
import { RuntimeTargets, type RuntimeWorker } from "@cardigan/host";
import {
  HC_RELEASE,
  type HcClient,
  hcCallPolicy,
} from "@cardigan/runtime-herdr";
import { listBellAttempts, Store } from "@cardigan/store";
import { expect, onTestFinished, test, vi } from "vitest";
import { governHcClient } from "../../../packages/runtime-herdr/src/call-queue.js";
import { HerdrRuntime } from "../../../packages/runtime-herdr/src/index.js";
import { sharedRepairStore } from "../test-support/shared-repair.js";
import { Dispatcher } from "./dispatch.js";

const value = <T>(result: RuntimeResult<T>): T => {
  if (!result.ok) throw Error(result.error.message);
  return result.value;
};
const machine = (id: string, alias = "local"): Machine => ({
  id,
  label: id,
  herdr_machine: alias,
  os: "linux",
  arch: "x64",
  tags: [],
  max_assignments: 1,
  status: "online",
  last_seen: "2026-01-01T00:00:00Z",
});
// The real agent-ssh adapter requires a Linux control plane. hc itself is a fixture.
test.runIf(process.platform === "linux")(
  "remote final refusal is not a lost acknowledgement",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "cg-remote-refusal-"));
    const store = Store.open({ dataDir: root });
    store.createProject({ id: "fixture" });
    onTestFinished(async () => {
      store.close();
      await rm(root, { recursive: true, force: true });
    });
    let workers: RuntimeWorker[] = ["worker-a"].map((id) => ({
      machine_id: id,
      project_id: "fixture",
      os: "linux",
      arch: "x64",
      session: id,
      generation: "one",
      allow_remote_launch: true,
      execution: {
        mode: "agent-ssh",
        dataDir: root,
        agentRoot: `/workers/${id}`,
        gid: 2001,
        machine: id,
        host: `${id}.invalid`,
        user: "project_a",
        identityFile: "/private/key",
        knownHostsFile: "/private/known_hosts",
        path: "/usr/bin:/bin",
        mcp: {
          url: "https://control.example-tailnet.ts.net/mcp",
          timeoutMs: 10000,
        },
        gitHelper: {
          python: "/usr/bin/python3",
          path: "/opt/worker/worker-git.py",
        },
        fileHelper: {
          python: "/usr/bin/python3",
          path: "/opt/worker/worker-files.py",
        },
        publication: {
          header_max_bytes: 4096,
          file_max_bytes: 2048,
          batch_max_bytes: 8192,
          timeout_ms: 2000,
        },
      },
    }));
    store.uow.run((tx) => {
      for (const worker of workers)
        tx.machines.put(
          "fixture",
          machine(worker.machine_id, worker.execution.machine),
        );
    });
    const socketPath = join(root, "wake.sock");
    const env = { CARDIGAN_HC_CONCURRENCY: "1" };
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let hold = false;
    let queued: Promise<void> | undefined;
    const client: HcClient = {
      available: async () => true,
      exec: vi.fn(async (args) => {
        if (args[0] === "--version") return `hc ${HC_RELEASE.version}`;
        if (args[0] === "machine") {
          if (args[1] === "ls") return JSON.stringify({ machines: [] });
          if (hold) {
            hold = false;
            queued = governed.queue.run(async () => {
              entered.resolve();
              await release.promise;
            });
          }
          return JSON.stringify({ version: HC_RELEASE.version });
        }
        return "";
      }),
      async *lines() {},
    };
    const governed = governHcClient(client, {
      socket: socketPath,
      session: "worker-a",
      policy: hcCallPolicy({ ...process.env, ...env }),
    });
    const key = join(root, "key"),
      known = join(root, "known");
    await writeFile(key, "fixture", { mode: 0o600 });
    await writeFile(known, "fixture", { mode: 0o600 });
    workers = workers.map((w) => ({
      ...w,
      execution: { ...w.execution, identityFile: key, knownHostsFile: known },
    }));
    const live = value(
      await RuntimeTargets.create({
        execution: { mode: "local", dataDir: root },
        store,
        project: "fixture",
        socketPath,
        env,
        client,
        factory: (options) => HerdrRuntime.create(options),
        workers: () => workers,
        workerReadiness: async () => [],
        workerMcpReachability: async () => {},
      }),
    );
    const target = (
      await live.forLaunch("fixture", {
        machine_id: "worker-a",
        runtime_ref: null,
      })
    ).execution.target;
    if (!target) throw new Error("Missing fixture target");
    const ref: RuntimeRef = {
      machine_id: "worker-a",
      runtime_machine: "worker-a",
      terminal_ref: "worker-a/t1",
      agent_name: "fixture",
      target,
    };
    // Use the production remote adapter and queue; only hc and clock are fixtures.
    const f = await sharedRepairStore();
    let first = true;
    const replies: unknown[] = [];
    const runtime: Runtime = {
      status: async () => ({
        ok: true,
        value: { process: "alive", agent: "idle", observed_seq: 0 },
      }),
      wake: async (_ref, bell, opts) => {
        const reply = await live.wake(ref, bell, opts);
        replies.push(reply);
        return reply;
      },
      provision: vi.fn(),
      release: vi.fn(),
      interrupt: vi.fn(),
      human_entry: vi.fn(),
      resume_or_replace: vi.fn(),
    };
    const loop = () =>
      new Dispatcher({
        store: f.store,
        clock: f.clock,
        runtime,
        startRun: vi.fn(),
        snapshot: async () => ({ model: "fixture", agent_cli_version: "1" }),
        beforeWake: async () => {
          if (first) {
            first = false;
            f.pause();
          }
        },
      });
    await loop().tick();
    const run = f
      .read()
      .runs.find((r) => r.assignment_id === f.owner && r.kind === "rework");
    if (!run) throw Error("Missing repair Run");
    expect(f.resume()?.payload).toMatchObject({ rework_run_id: run.id });
    const history = () =>
      listBellAttempts(f.store.database, f.project, run.id).map((a) => ({
        outcome: a.outcome,
        crossed: !!a.review_wake?.sending_at,
      }));
    hold = true;
    const sending = loop().tick();
    try {
      await entered.promise;
      store.uow.run((tx) =>
        tx.machines.put("fixture", {
          ...machine("worker-a", "worker-a"),
          status: "offline",
        }),
      );
    } finally {
      release.resolve();
    }
    await sending;
    await queued;
    const count = () =>
      vi.mocked(client.exec).mock.calls.filter(([args]) => args[0] === "send")
        .length;
    expect(count()).toBe(0);
    expect(replies).toEqual([
      { ok: true, value: { sent: false, withdrawn: true } },
    ]);
    const afterRefusal = history();
    store.uow.run((tx) =>
      tx.machines.put("fixture", machine("worker-a", "worker-a")),
    );
    await loop().tick();
    f.advance(60_001);
    await loop().tick();
    f.advance(30_001);
    await loop().tick();
    expect(afterRefusal).toEqual([{ outcome: "failed", crossed: false }]);
    expect(count()).toBe(1);
    expect(runtime.release).not.toHaveBeenCalled();
  },
);

// Also exercise the receipt/lease race on hosts without the Linux adapter.
test("a final refusal after lease expiry still restores the original repair", async () => {
  const f = await sharedRepairStore();
  const entered = Promise.withResolvers<void>(),
    reply = Promise.withResolvers<void>();
  let writes = 0,
    first = true;
  const runtime: Runtime = {
    status: async () => ({
      ok: true,
      value: { process: "alive", agent: "idle", observed_seq: 0 },
    }),
    wake: async (_ref, _bell, options) => {
      if (!options?.before_send?.())
        return { ok: true, value: { sent: false, withdrawn: true } };
      if (first) {
        first = false;
        entered.resolve();
        await reply.promise;
        return { ok: true, value: { sent: false, withdrawn: true } };
      }
      writes++;
      return { ok: true, value: { sent: true } };
    },
    release: vi.fn(),
    provision: vi.fn(),
    resume_or_replace: vi.fn(),
    human_entry: vi.fn(),
    interrupt: vi.fn(),
  };
  const tick = (pause = false) =>
    new Dispatcher({
      store: f.store,
      clock: f.clock,
      runtime,
      startRun: vi.fn(),
      snapshot: async () => ({ model: "fixture", agent_cli_version: "1" }),
      beforeWake: async () => {
        if (pause) f.pause();
      },
    }).tick();
  await tick(true);
  f.resume();
  const sending = tick();
  try {
    await entered.promise;
    f.advance(60_001);
    await tick();
    expect(writes).toBe(0);
  } finally {
    reply.resolve();
  }
  await sending;
  f.advance(30_001);
  await tick();
  await tick();
  expect(writes).toBe(1);
  expect(runtime.release).not.toHaveBeenCalled();
});
