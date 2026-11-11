import { type CliIo, startAssignment } from "@cardigan/cli";
import type { Assignment, Runtime, RuntimeRef } from "@cardigan/domain";
import {
  acknowledgeRun,
  dispatchRun,
  finishRun,
  issueInstruction,
} from "@cardigan/domain";
import { defaultToolCatalog } from "@cardigan/mcp-server";
import { parseLaunchConfig } from "@cardigan/roles";
import { tokensForAssignment } from "@cardigan/store";
import { afterEach, expect, test, vi } from "vitest";
import { dispatchFixture } from "../test-support/dispatch.js";
import { Dispatcher, type DispatcherOptions } from "./dispatch.js";

// P2a-10 A, review V-265: a session started or reused through the shared host
// launch path (cardigan assignment start / pm start) records and keeps its
// tools/list fingerprint, so a later deploy is detected on a natural wake.

const launch = {
  config: parseLaunchConfig({
    profiles: { fixture: { harness: "pi", model: "fixture-model" } },
  }),
  secrets: {},
};
const fixtures: ReturnType<typeof dispatchFixture>[] = [];
afterEach(() => {
  for (const f of fixtures.splice(0)) f.close();
});

function fixture() {
  const f = dispatchFixture();
  fixtures.push(f);
  const { assignment, card, item } = f.create();
  let alive = false;
  const refFor = (agent: string, terminal = "t1"): RuntimeRef => ({
    machine_id: "local",
    runtime_machine: "local",
    terminal_ref: terminal,
    agent_name: agent,
  });
  const runtime: Runtime = {
    provision: vi.fn(async (_a, _r, _m, desc) => {
      alive = true;
      return { ok: true as const, value: refFor(desc.agent_name) };
    }),
    release: vi.fn(async () => ({ ok: true as const, value: undefined })),
    wake: vi.fn(async () => ({ ok: true as const, value: { sent: true } })),
    status: vi.fn(async () =>
      alive
        ? {
            ok: true as const,
            value: {
              process: "alive" as const,
              agent: "idle" as const,
              observed_seq: 1,
            },
          }
        : {
            ok: false as const,
            error: { code: "runtime_not_found" as const, message: "none" },
          },
    ),
    interrupt: async () => ({ ok: true as const, value: undefined }),
    resume_or_replace: vi.fn(async (old: RuntimeRef, desc) => ({
      ok: true as const,
      value: { ...old, terminal_ref: "t2", agent_name: desc.agent_name },
    })),
    human_entry: async () => ({ ok: true as const, value: "attach" }),
  };
  const io: CliIo = {
    env: { CARDIGAN_DATA_DIR: f.dataDir },
    cwd: f.dataDir,
    platform: "linux",
    stdout: () => undefined,
    stderr: () => undefined,
    signals: { on: () => undefined, off: () => undefined },
    spawnInherit: () => {
      throw new Error("assignment start must not spawn");
    },
    captureCommand: async () => ({
      code: 0,
      stdout: "pi 1.5.0-fixture\n",
      stderr: "",
    }),
  };
  const current = () =>
    f.state().assignments.find((a) => a.id === assignment.id) as Assignment;
  const startFromCli = () =>
    startAssignment({
      store: f.store,
      io,
      project_id: f.project,
      assignment_id: assignment.id,
      launch,
      mcpUrl: "http://127.0.0.1:3004/mcp",
      runtime,
      dataDir: f.dataDir,
    });
  const finishLatest = () => {
    const run = f.state().runs.at(-1);
    if (!run) throw new Error("No Run");
    const agent = f.actorFor(assignment);
    if (run.status === "dispatched")
      f.apply((s, a, p) => acknowledgeRun(s, a, { run_id: run.id }, p), agent);
    f.apply(
      (s, a, p) =>
        finishRun(
          s,
          a,
          { run_id: run.id, outcome: "completed", summary: "Done" },
          p,
        ),
      agent,
    );
  };
  /** What this deploy's endpoint serves to the Assignment's current token. */
  const served = () =>
    defaultToolCatalog(
      tokensForAssignment(f.store.database, f.project, assignment.id).at(-1)
        ?.allowed_tools ?? [],
      current(),
    );
  let deployed: string | undefined;
  const dispatcher: DispatcherOptions = {
    store: f.store,
    clock: f.clock,
    runtime,
    toolCatalog: () => deployed ?? served(),
    snapshot: async () => ({
      model: "fixture-model",
      agent_cli_version: "pi 1.5.0-fixture",
    }),
    startRun: vi.fn(async ({ run, replacement }) => {
      const ref = replacement
        ? await runtime.resume_or_replace(replacement.previous, {
            command: "agent",
            args: [],
            cwd: f.dataDir,
            agent_name: replacement.previous.agent_name,
            labels: { run: run.id },
          })
        : undefined;
      f.apply(
        (s, a, p) =>
          dispatchRun(
            s,
            a,
            {
              run_id: run.id,
              ...(ref?.ok ? { runtime_ref: ref.value } : {}),
              ...(replacement ? { replacement } : {}),
            },
            p,
          ),
        { kind: "system", project_id: f.project },
      );
    }),
  };
  const wake = () =>
    f.apply((s, a, p) =>
      issueInstruction(
        s,
        a,
        { card_id: card.id, work_item_id: item.id, body: "Continue" },
        p,
      ),
    );
  return {
    ...f,
    assignment,
    runtime,
    startFromCli,
    finishLatest,
    served,
    dispatcher,
    wake,
    deploy: (catalog: string) => {
      deployed = catalog;
    },
    replaced: () =>
      f.state().events.filter((e) => e.type === "session_replaced"),
  };
}

test("P2a-10 A: a CLI-started session records the catalog its token lists", async () => {
  const x = fixture();
  await x.startFromCli();
  const run = x.state().runs.at(-1);
  expect(run?.status).toBe("dispatched");
  expect(run?.tool_catalog).toMatch(/^[a-f0-9]{64}$/u);
  expect(run?.tool_catalog).toBe(x.served());
});

test("P2a-10 A: a CLI start that reuses the live session keeps its catalog", async () => {
  const x = fixture();
  await x.startFromCli();
  const first = x.state().runs.at(-1)?.tool_catalog;
  x.finishLatest();
  await x.startFromCli();
  expect(x.runtime.provision).toHaveBeenCalledOnce();
  expect(x.runtime.wake).toHaveBeenCalledOnce();
  const runs = x.state().runs;
  expect(runs).toHaveLength(2);
  expect(runs[1]).toMatchObject({ status: "dispatched", tool_catalog: first });
});

test("P2a-10 A: after a CLI start, the same deploy wakes and a new deploy replaces on the natural wake", async () => {
  const x = fixture();
  await x.startFromCli();
  x.finishLatest();
  // Same deploy: the fingerprint matches, so the live session is reused.
  x.wake();
  await new Dispatcher(x.dispatcher).tick();
  expect(x.runtime.wake).toHaveBeenCalledOnce();
  expect(x.replaced()).toEqual([]);
  x.finishLatest();
  // New deploy with a different tools/list: the next natural wake replaces.
  x.deploy("deploy-v2");
  x.wake();
  await new Dispatcher(x.dispatcher).tick();
  expect(x.runtime.wake).toHaveBeenCalledOnce();
  expect(x.runtime.resume_or_replace).toHaveBeenCalledOnce();
  expect(x.replaced()).toHaveLength(1);
  expect(x.replaced()[0]?.payload).toMatchObject({
    reason: "tool_catalog_changed",
  });
  expect(x.state().runs.at(-1)).toMatchObject({
    status: "dispatched",
    tool_catalog: "deploy-v2",
  });
});
