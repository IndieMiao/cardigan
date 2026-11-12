import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type CliIo, startAssignment } from "@cardigan/cli";
import {
  acknowledgeRun,
  finishRun,
  postComment,
  queueRun,
  type Runtime,
} from "@cardigan/domain";
import { parseLaunchConfig } from "@cardigan/roles";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { dispatchFixture } from "../test-support/dispatch.js";
import { Dispatcher } from "./dispatch.js";

let f: ReturnType<typeof dispatchFixture>;
let target: ReturnType<typeof f.create>;
let runtime: Runtime;
beforeEach(() => {
  f = dispatchFixture();
  target = f.create();
  runtime = {
    provision: vi.fn(async () => ({
      ok: true,
      value: f.refFor(target.assignment),
    })),
    status: vi.fn(async () => ({
      ok: true,
      value: { process: "alive", agent: "idle", observed_seq: 1 },
    })),
    wake: vi.fn(async () => ({ ok: true, value: { sent: true } })),
    release: vi.fn(async () => ({ ok: true, value: undefined })),
    interrupt: async () => ({ ok: true, value: undefined }),
    human_entry: async () => ({ ok: true, value: "fixture" }),
    resume_or_replace: async () => {
      throw new Error("unused");
    },
  };
});
afterEach(() => f.close());

const start = () =>
  startAssignment({
    store: f.store,
    io: {
      env: { CARDIGAN_RUNTIME_MODE: "local", CARDIGAN_DATA_DIR: f.dataDir },
      cwd: f.dataDir,
      captureCommand: async () => ({
        code: 0,
        stdout: "pi fixture",
        stderr: "",
      }),
      stderr: () => {},
      stdout: () => {},
      platform: "linux",
      signals: { on: () => {}, off: () => {} },
      spawnInherit: () => {
        throw new Error("unused");
      },
    } satisfies CliIo,
    project_id: f.project,
    assignment_id: target.assignment.id,
    launch: {
      config: parseLaunchConfig({
        profiles: { fixture: { harness: "pi", model: "fixture-model" } },
      }),
      secrets: {},
    },
    mcpUrl: "http://127.0.0.1:3004/mcp",
    runtime,
    dataDir: f.dataDir,
  });
const queue = (kind: "decision_resumed" | "rework" | "fix") =>
  f.apply((s, a, p) =>
    queueRun(
      s,
      a,
      {
        assignment_id: target.assignment.id,
        kind,
        model: "fixture-model",
        agent_cli_version: "pi fixture",
      },
      p,
    ),
  );
const acknowledge = (run_id: Parameters<typeof acknowledgeRun>[2]["run_id"]) =>
  f.apply(
    (s, a, p) => acknowledgeRun(s, a, { run_id }, p),
    f.actorFor(target.assignment),
  );

test.each(["decision_resumed", "rework", "fix"] as const)(
  "assignment start launches prequeued %s without a prior session or a second Run",
  async (kind) => {
    const queued = queue(kind);
    const started = await start();
    expect(started.run_id).toBe(queued.id);
    expect(readFileSync(join(started.run_dir, "first.md"), "utf8")).toContain(
      `kind=${kind}`,
    );
    acknowledge(queued.id);
    expect(f.state().runs).toHaveLength(1);
    expect(f.state().runs[0]).toMatchObject({
      id: queued.id,
      kind,
      status: "running",
      trigger_event_id: queued.trigger_event_id,
    });
    expect(runtime.provision).toHaveBeenCalledOnce();
  },
);

test.each(["alive", "exited"] as const)(
  "assignment start consumes a queued Run with an %s previous session",
  async (process) => {
    const previous = await start();
    const run = f.state().runs[0];
    if (!run) throw new Error("Missing Run");
    acknowledge(run.id);
    f.apply(
      (s, a, p) =>
        finishRun(
          s,
          a,
          { run_id: run.id, outcome: "completed", summary: "done" },
          p,
        ),
      f.actorFor(target.assignment),
    );
    const queued = queue("decision_resumed");
    vi.mocked(runtime.status).mockResolvedValue({
      ok: true,
      value: { process, agent: "idle", observed_seq: 2 },
    });
    const started = await start();
    expect(started.run_id).toBe(queued.id);
    acknowledge(queued.id);
    expect(f.state().runs).toHaveLength(2);
    expect(f.state().runs.at(-1)?.status).toBe("running");
    expect(runtime.provision).toHaveBeenCalledTimes(
      process === "alive" ? 1 : 2,
    );
    if (process === "alive") {
      expect(runtime.wake).toHaveBeenCalledWith(
        previous.runtime_ref,
        expect.stringContaining(`run=${queued.id} kind=decision_resumed`),
      );
      expect(started.token_id).toBe(previous.token_id);
    }
  },
);

test("assignment start rejects a running Run before waking, provisioning or rotating tokens", async () => {
  await start();
  const run = f.state().runs[0];
  if (!run) throw new Error("Missing Run");
  acknowledge(run.id);
  const tokens = f.store.uow.run((tx) =>
    tx.tokensForAssignment(f.project, target.assignment.id),
  );
  await expect(start()).rejects.toThrow(/invariant_violation/);
  expect(f.state().runs).toHaveLength(1);
  expect(runtime.provision).toHaveBeenCalledOnce();
  expect(runtime.wake).not.toHaveBeenCalled();
  expect(
    f.store.uow.run((tx) =>
      tx.tokensForAssignment(f.project, target.assignment.id),
    ),
  ).toEqual(tokens);
});

test("concurrent assignment starts cannot provision or rotate tokens for the same queued Run", async () => {
  queue("fix");
  let resume = () => {};
  vi.mocked(runtime.provision).mockImplementationOnce(async () => {
    await new Promise<void>((resolve) => {
      resume = resolve;
    });
    return { ok: true, value: f.refFor(target.assignment) };
  });
  const starting = start();
  void starting.catch(() => {});
  try {
    await expect
      .poll(() => vi.mocked(runtime.provision).mock.calls.length)
      .toBe(1);
    const tokens = f.store.uow.run((tx) =>
      tx.tokensForAssignment(f.project, target.assignment.id),
    );
    await expect(start()).rejects.toThrow(/delivery is in progress/);
    expect(
      f.store.uow.run((tx) =>
        tx.tokensForAssignment(f.project, target.assignment.id),
      ),
    ).toEqual(tokens);
    expect(runtime.provision).toHaveBeenCalledOnce();
    f.apply((s, a, p) =>
      postComment(
        s,
        a,
        {
          card_id: target.card.id,
          work_item_id: target.item.id,
          body: "Continue",
        },
        p,
      ),
    );
    const startRun = vi.fn(async () => {});
    await new Dispatcher({
      store: f.store,
      runtime,
      snapshot: async () => ({
        model: "fixture-model",
        agent_cli_version: "pi fixture",
      }),
      startRun,
    }).tick();
    expect(startRun).not.toHaveBeenCalled();
    expect(runtime.wake).not.toHaveBeenCalled();
  } finally {
    resume();
    await starting;
  }
});
