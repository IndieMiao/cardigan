import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { queueRun, type Runtime } from "@cardigan/domain";
import { HostLaunchError, launchRun, RunTargetDeferred } from "@cardigan/host";
import { loadCommandState, persistEffect } from "@cardigan/mcp-server";
import { parseLaunchConfig } from "@cardigan/roles";
import { HerdrRuntime } from "@cardigan/runtime-herdr";
import { listBellAttempts } from "@cardigan/store";
import { expect, onTestFinished, test, vi } from "vitest";
import {
  machine,
  value,
} from "../../../packages/domain/src/commands/test-fixtures.js";
import { HC_RELEASE } from "../../../packages/runtime-herdr/src/hc-version.js";
import { sharedRepairStore as fixture } from "../test-support/shared-repair.js";
import { Dispatcher } from "./dispatch.js";

test.each(["resume-before-withdrawal-record", "lost-send-reply"] as const)(
  "direct start: %s",
  async (phase) => {
    const f = await fixture();
    const human = { kind: "human" as const, project_id: f.project };
    const run = f.store.uow.run((tx) => {
      tx.machines.put(f.project, machine());
      tx.issueToken({
        project_id: f.project,
        assignment_id: f.owner,
        role: { role_version: 1, allowed_tools: ["whoami"] },
      });
      const s = loadCommandState(tx, f.project);
      const rejected = s.events.findLast((e) => e.type === "review_submitted");
      if (!rejected) throw Error("Missing rejection");
      const result = value(
        queueRun(
          s,
          human,
          {
            assignment_id: f.owner,
            model: "fixture",
            agent_cli_version: "1",
            kind: "rework",
            trigger_event_id: rejected.id,
          },
          { clock: f.clock, ids: tx.ids },
        ),
      );
      persistEffect(tx, f.project, result);
      return result.data;
    });
    let sends = 0,
      firstGuard = true;
    const release = vi.fn();
    const runtime: Runtime = {
      status: async () => ({
        ok: true,
        value: { process: "alive", agent: "idle", observed_seq: 0 },
      }),
      wake: async (_ref, _bell, opts) => {
        if (firstGuard) {
          firstGuard = false;
          f.pause();
          if (phase === "lost-send-reply") {
            f.resume();
            expect(opts?.before_send?.()).toBe(true);
            sends++;
            return {
              ok: false,
              error: {
                code: "runtime_timeout",
                message: "lost reply after write",
              },
            };
          }
          expect(opts?.before_send?.()).toBe(false);
          // Rejected guard already proves non-send; the adapter still holds its reply.
          f.resume();
          return { ok: true, value: { sent: false, withdrawn: true } };
        }
        if (opts?.before_send && !opts.before_send())
          return { ok: true, value: { sent: false, withdrawn: true } };
        sends++;
        return { ok: true, value: { sent: true } };
      },
      release,
      provision: vi.fn(),
      interrupt: vi.fn(),
      resume_or_replace: vi.fn(),
      human_entry: vi.fn(),
    };
    const tmp = mkdtempSync(join(tmpdir(), "cg-direct-start-"));
    onTestFinished(() => rmSync(tmp, { recursive: true, force: true }));
    const host = {
      store: f.store,
      runtime,
      clock: f.clock,
      dataDir: tmp,
      mcpUrl: "http://localhost.invalid/mcp",
      launch: {
        config: parseLaunchConfig({
          profiles: { acceptance: { harness: "pi", model: "fixture" } },
        }),
        secrets: {},
      },
    };
    await expect(
      launchRun(host, {
        project: f.project,
        assignment_id: f.owner,
        actor: human,
        run,
        reuse_session: true,
        prepare_worktree: async () => undefined,
      }),
    ).rejects.toBeInstanceOf(
      phase === "lost-send-reply" ? HostLaunchError : RunTargetDeferred,
    );
    const loop = new Dispatcher({
      store: f.store,
      clock: f.clock,
      runtime,
      startRun: vi.fn(),
      snapshot: async () => ({ model: "fixture", agent_cli_version: "1" }),
    });
    await loop.tick();
    f.advance(30_001);
    await loop.tick();
    const last = listBellAttempts(f.store.database, f.project, run.id).at(-1);
    expect(last?.review_wake).toMatchObject({
      delivery_id: f.target.id,
      target_sha: f.target.subject.value,
      sending_at: expect.any(String),
    });
    expect(last?.outcome).toBe(phase === "lost-send-reply" ? "failed" : "sent");
    expect(release).not.toHaveBeenCalled();
    expect(sends).toBe(1);
  },
);

test("a confirmed withdrawal has no ack deadline until a send can be claimed", async () => {
  const f = await fixture();
  let paused = false,
    skipStatus = false,
    stopped = false,
    sent = 0;
  const release = vi.fn(async () => {
    stopped = true;
    return { ok: true as const, value: undefined };
  });
  const runtime: Runtime = {
    status: async () =>
      skipStatus
        ? {
            ok: false,
            error: {
              code: "runtime_unavailable",
              message: "one transient status read",
            },
          }
        : {
            ok: true,
            value: {
              process: stopped ? "exited" : "alive",
              agent: "idle",
              observed_seq: 0,
            },
          },
    wake: async (_ref, _bell, opts) => {
      if (!paused) {
        paused = true;
        f.pause();
      }
      if (opts?.before_send && !opts.before_send())
        return { ok: true, value: { sent: false, withdrawn: true } };
      sent++;
      return { ok: true, value: { sent: true } };
    },
    release,
    provision: vi.fn(),
    interrupt: vi.fn(),
    resume_or_replace: vi.fn(),
    human_entry: vi.fn(),
  };
  const dispatcher = () =>
    new Dispatcher({
      store: f.store,
      clock: f.clock,
      runtime,
      startRun: vi.fn(),
      snapshot: async () => ({ model: "fixture", agent_cli_version: "1" }),
    });
  await dispatcher().tick();
  const run = f
    .read()
    .runs.find((r) => r.assignment_id === f.owner && r.kind === "rework");
  if (!run) throw Error("Missing repair");
  const history = () =>
    listBellAttempts(f.store.database, f.project, run.id).map((a) => a.outcome);
  expect(history()).toEqual([]);
  expect(sent).toBe(0);
  f.resume();
  skipStatus = true;
  await dispatcher().tick();
  expect(history()).toEqual([]);
  expect(release).not.toHaveBeenCalled();
  // No delivery attempt exists while the dispatcher is offline. At startup
  // the same healthy session is reachable and the same delivery still needs repair.
  f.advance(10 * 60_000 + 1);
  skipStatus = false;
  await dispatcher().tick();
  expect({
    sent,
    release: release.mock.calls.length,
    attempts: history(),
  }).toEqual({ sent: 1, release: 0, attempts: ["sent"] });
});

test("confirmed withdrawal: brief adapter outage before send guard must preserve normal retry", async () => {
  const f = await fixture();
  let available = true,
    writes = 0,
    guards = 0,
    first = true;
  const errors: string[] = [];
  const hr = await HerdrRuntime.create({
    client: {
      available: async () => available,
      exec: async (args) => {
        if (args[0] === "--version") return `hc ${HC_RELEASE.version}`;
        if (args[0] === "send") {
          writes++;
          return "{}";
        }
        throw new Error(`unexpected ${args[0]}`);
      },
      async *lines() {},
    },
  });
  if (!hr.ok) throw new Error(hr.error.message);
  const release = vi.fn(async () => ({ ok: true as const, value: undefined }));
  const runtime: Runtime = {
    status: async () => ({
      ok: true,
      value: { process: "alive", agent: "idle", observed_seq: 0 },
    }),
    wake: async (_ref, bell, opts) => {
      const r = await hr.value.wake({ ..._ref, terminal_ref: "t1" }, bell, {
        before_send: () => {
          guards++;
          return opts?.before_send?.() ?? true;
        },
      });
      if (!r.ok) errors.push(r.error.code);
      return r;
    },
    release,
    provision: vi.fn(),
    interrupt: vi.fn(),
    resume_or_replace: vi.fn(),
    human_entry: vi.fn(),
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
  if (!run) throw new Error("missing rework");
  const attempts = () =>
    listBellAttempts(f.store.database, f.project, run.id).map((a) => a.outcome);
  expect([writes, guards, attempts()]).toEqual([0, 0, []]);
  expect(f.resume()?.payload).toMatchObject({ rework_run_id: run.id });
  available = false;
  await loop().tick(); // HerdrRuntime.live() fails, before execIfCurrent.
  expect([writes, guards, attempts()]).toEqual([0, 0, ["failed"]]);
  expect(errors).toEqual(["runtime_unavailable"]);
  available = true;
  f.advance(30_001);
  await loop().tick();
  expect([writes, guards, attempts()]).toEqual([1, 1, ["failed", "sent"]]);
  expect(release).not.toHaveBeenCalled();
});
