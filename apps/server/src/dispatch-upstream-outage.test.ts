import type {
  Assignment,
  HarnessActivity,
  PromptObservation,
  Run,
  Runtime,
} from "@cardigan/domain";
import type {
  HarnessActivityInspection,
  UpstreamModelProbe,
} from "@cardigan/host";
import type { LaunchConfig } from "@cardigan/roles";
import { afterEach, expect, test, vi } from "vitest";
import { dispatchFixture } from "../test-support/dispatch.js";
import { Dispatcher } from "./dispatch.js";
import type { UpstreamOutageRecovery } from "./dispatch-upstream-outage.js";

const fixtures: ReturnType<typeof dispatchFixture>[] = [];
const dispatchers: Dispatcher[] = [];
afterEach(async () => {
  for (const d of dispatchers.splice(0)) await d.close();
  for (const f of fixtures.splice(0)) f.close();
  vi.restoreAllMocks();
});
const settle = async () => {
  for (let i = 0; i < 30; i++)
    await new Promise<void>((resolve) => setImmediate(resolve));
};

const launch = {
  providers: {
    relay: { api: "anthropic-messages", base_url: "https://relay.invalid" },
    official: {},
  },
  profiles: {
    "claude-opus-high": {
      harness: "claude-code",
      provider: "relay",
      model: "claude-opus",
    },
    "claude-official": { harness: "claude-code", provider: "official" },
    "codex-high": { harness: "codex" },
  },
} as unknown as LaunchConfig;

/**
 * C-821 field case: a relay without accounts; every Claude Code session of
 * that relay stops on `API Error: 503 No available accounts`.
 */
function outage(sessions = 2, error: "outage" | "disconnect" = "outage") {
  const f = dispatchFixture();
  fixtures.push(f);
  const targets: { a: Assignment; run: Run }[] = [];
  for (let n = 0; n < sessions; n++) {
    const { assignment } = f.create();
    const run = f.session(assignment, false);
    f.store.uow.run((tx) =>
      tx.runs.put(f.project, {
        ...tx.runs.get(f.project, run.id)!,
        harness: "claude-code",
        launch_profile_ref: "claude-opus-high",
      }),
    );
    const a = f.state().assignments.find((x) => x.id === assignment.id)!;
    targets.push({ a, run });
  }
  const startedAt = f.clock.now();
  f.advance(16 * 60_000);
  const stuck = new Set(targets.map((t) => t.a.runtime_ref!.terminal_ref));
  const sent: string[] = [];
  const observe = vi.fn(
    async (ref: { terminal_ref: string }, binding: PromptObservation) => ({
      ok: true as const,
      value:
        binding.require_upstream_error ===
          (error === "disconnect" ? "disconnect" : true) &&
        stuck.has(ref.terminal_ref),
    }),
  );
  const runtime = {
    status: vi.fn(async () => ({
      ok: true,
      value: { process: "alive", agent: "idle", observed_seq: 1 },
    })),
    observe_prompt: observe,
    wake: vi.fn<Runtime["wake"]>(async (ref, message, options) => {
      const bound = options?.prompt_binding;
      if (bound && !(await observe(ref, bound)).value)
        return { ok: true, value: { sent: false, withdrawn: true } };
      if (options?.before_send && !options.before_send())
        return { ok: true, value: { sent: false, withdrawn: true } };
      sent.push(message);
      // The resumed session clears the error and works again.
      stuck.delete(ref.terminal_ref);
      return { ok: true, value: { sent: true } };
    }),
    release: vi.fn(),
  } as unknown as Runtime;
  let probe: UpstreamModelProbe = {
    ok: false,
    failure: "http_status",
    status: 503,
  };
  const probes = vi.fn(async () => probe);
  // Without any transcript progress the normal flow alerts every session.
  const inspection = vi.fn(async () => {
    const state = f.state();
    return new Map<Assignment["id"], HarnessActivityInspection>(
      targets.map(({ a, run }) => [
        a.id,
        {
          status: "stale",
          activity: {
            assignment_id: a.id,
            run_id: run.id,
            runtime_key: JSON.stringify(
              state.assignments.find((x) => x.id === a.id)?.runtime_ref,
            ),
            session_id: "fixture-session",
            source: "claude-code:session_metadata",
            stale_after_ms: 60_000,
            updated_at: startedAt,
          } satisfies HarnessActivity,
        },
      ]),
    );
  });
  const options = {
    store: f.store,
    runtime,
    clock: f.clock,
    snapshot: async () => ({ model: "fixture", agent_cli_version: "fixture" }),
    inactiveCancelAfterMs: 60 * 60_000,
    inspectHarnessActivity: inspection,
    upstreamOutage: { launch: () => launch, probe: probes },
  };
  const d = new Dispatcher(options);
  dispatchers.push(d);
  const events = (type: string) =>
    f.state().events.filter((e) => e.type === type);
  const tick = async (dispatcher = d) => {
    await dispatcher.tick();
    await settle();
    await (
      dispatcher as unknown as { upstreamOutage: UpstreamOutageRecovery }
    ).upstreamOutage.settled();
    await settle();
  };
  return {
    f,
    d,
    targets,
    runtime,
    sent,
    stuck,
    probes,
    tick,
    events,
    recover() {
      probe = { ok: true };
    },
  };
}

test("C-821: a relay returning 503 No available accounts is one outage per provider, with no per-session alert or handoff", async () => {
  const t = outage(3);
  await t.tick();
  await t.tick();
  expect(t.events("run_inactive")).toEqual([]);
  expect(t.events("upstream_outage_started")).toHaveLength(1);
  expect(t.events("upstream_outage_started")[0]?.payload).toMatchObject({
    provider: "relay",
  });
  expect(t.events("upstream_outage_session_added")).toHaveLength(3);
  expect(t.f.state().human_actions).toEqual([]);
  const ids = new Set(
    t.f
      .state()
      .events.filter((e) => e.type.startsWith("upstream_outage"))
      .map((e) => e.id),
  );
  expect(
    t.f.store
      .listNotifications({ project_id: t.f.project })
      .filter((n) => ids.has(n.event_id)),
  ).toEqual([]);
  // The line diagnosis on the health view names the outage.
  expect(t.runtime.release).not.toHaveBeenCalled();
});

test("C-821: after the relay recovers every stopped session gets one resume message and continues", async () => {
  const t = outage(2);
  await t.tick();
  t.f.advance(61_000);
  await t.tick();
  expect(t.probes).toHaveBeenCalledWith(
    "claude-opus-high",
    expect.any(AbortSignal),
  );
  expect(t.events("upstream_outage_resolved")).toEqual([]);
  expect(t.sent).toEqual([]);
  t.recover();
  t.f.advance(61_000);
  await t.tick();
  expect(t.events("upstream_outage_resolved")).toHaveLength(1);
  await t.tick();
  expect(t.sent).toHaveLength(2);
  for (const message of t.sent) {
    expect(message).toMatch(
      /^模型服务 relay 在 \d\d:\d\dZ 到 \d\d:\d\dZ 中断，现已恢复。请从中断处继续当前 R-\d+ 的工作。$/u,
    );
  }
  expect(
    t.events("upstream_outage_resume").map((e) => e.payload),
  ).toMatchObject([{ result: "sent" }, { result: "sent" }]);
  expect(t.stuck.size).toBe(0);
  // The same Run never gets a second message, even after a restart.
  const again = new Dispatcher({
    ...(t.d.options as ConstructorParameters<typeof Dispatcher>[0]),
  });
  dispatchers.push(again);
  await t.tick(again);
  await t.tick();
  expect(t.sent).toHaveLength(2);
  for (const { run } of t.targets)
    expect(t.f.state().runs.find((r) => r.id === run.id)?.status).toBe(
      "running",
    );
});

test("C-821: a session that left the error screen before recovery is not messaged", async () => {
  const t = outage(2);
  await t.tick();
  const [first] = t.targets;
  t.stuck.delete(first!.a.runtime_ref!.terminal_ref);
  t.recover();
  t.f.advance(61_000);
  await t.tick();
  await t.tick();
  expect(t.sent).toHaveLength(1);
  expect(
    t
      .events("upstream_outage_resume")
      .map((e) => [
        (e.payload as { run_id: string }).run_id,
        (e.payload as { result: string }).result,
      ]),
  ).toEqual(
    expect.arrayContaining([
      [first!.run.id, "skipped"],
      [t.targets[1]!.run.id, "sent"],
    ]),
  );
});

test("C-821: a long outage reminds Needs You once with the affected employees and other launch profiles", async () => {
  const t = outage(2);
  await t.tick();
  for (let m = 0; m < 32; m++) {
    t.f.advance(61_000);
    await t.tick();
  }
  const actions = t.f.state().human_actions;
  expect(actions).toHaveLength(1);
  expect(actions[0]?.status).toBe("open");
  for (const { a } of t.targets)
    expect(actions[0]?.instructions).toContain(a.id);
  expect(actions[0]?.instructions).toContain(
    "可临时切换的启动配置：claude-official、codex-high。",
  );
  expect(t.events("upstream_outage_reminded")).toHaveLength(1);
  // Held sessions are neither alerted nor stopped while waiting.
  expect(t.events("run_inactive")).toEqual([]);
  expect(t.runtime.release).not.toHaveBeenCalled();
  t.recover();
  t.f.advance(61_000);
  await t.tick();
  expect(t.f.state().human_actions[0]?.status).toBe("cancelled");
});

test("C-821: a session already alerted as inactive still joins the outage and is resumed", async () => {
  const t = outage(1);
  const [{ a, run }] = t.targets as [{ a: Assignment; run: Run }];
  t.f.store.uow.run((tx) =>
    tx.events.append(t.f.project, {
      id: tx.ids.nextEventId(),
      seq: tx.ids.nextEventSequence(t.f.project),
      type: "run_inactive",
      actor: { kind: "system", project_id: t.f.project },
      payload: {
        assignment_id: a.id,
        run_id: run.id,
        reason: "mcp_inactivity",
      },
      created_at: t.f.clock.now(),
    }),
  );
  await t.tick();
  expect(t.events("upstream_outage_session_added")).toHaveLength(1);
  t.recover();
  t.f.advance(61_000);
  await t.tick();
  await t.tick();
  expect(t.sent).toHaveLength(1);
});

/**
 * C-842 field case: the relay is fine, but one Claude Code turn ended with
 * `API Error: Connection lost mid-response` and the CLI sat at its empty
 * editor while the Run stayed running.
 */
test("C-842: a session stopped on a dropped connection is resumed once the provider answers, with a timeline record and no alert", async () => {
  const t = outage(1, "disconnect");
  t.recover();
  await t.tick();
  await t.tick();
  await t.tick();
  expect(t.events("run_inactive")).toEqual([]);
  expect(t.events("upstream_outage_started")[0]?.payload).toMatchObject({
    provider: "relay",
    cause: "disconnect",
  });
  expect(t.events("upstream_outage_session_added")[0]?.payload).toMatchObject({
    error: "disconnect",
  });
  expect(t.probes).toHaveBeenCalledOnce();
  expect(t.events("upstream_outage_resolved")).toHaveLength(1);
  expect(t.sent).toEqual([
    `上一条回复因与模型服务 relay 的连接中断没有完成，服务现在可用。请从中断处继续当前 ${t.targets[0]!.run.id} 的工作。`,
  ]);
  const timeline = t.f.state().timeline.map((e) => e.body);
  expect(timeline).toEqual(
    expect.arrayContaining([
      expect.stringContaining("连接在回复中途断开（本轮第 1 次"),
      expect.stringContaining("连接中断后停住，服务现在可用"),
    ]),
  );
  expect(t.f.state().human_actions).toEqual([]);
  expect(t.runtime.release).not.toHaveBeenCalled();
});

test("C-842: no resume while the provider does not answer the probe", async () => {
  const t = outage(1, "disconnect");
  await t.tick();
  t.f.advance(61_000);
  await t.tick();
  expect(t.events("upstream_outage_session_added")).toHaveLength(1);
  expect(t.events("upstream_outage_resolved")).toEqual([]);
  expect(t.sent).toEqual([]);
  expect(t.events("run_inactive")).toEqual([]);
});

test("C-842: repeated disconnects of one Run are resumed up to the limit, then the inactivity flow alerts host ops instead of resending", async () => {
  const t = outage(1, "disconnect");
  const terminal = t.targets[0]!.a.runtime_ref!.terminal_ref;
  t.recover();
  await t.tick();
  await t.tick();
  await t.tick();
  expect(t.sent).toHaveLength(1);
  // It drops again after the resume window.
  t.stuck.add(terminal);
  t.f.advance(11 * 60_000);
  await t.tick();
  t.f.advance(61_000);
  await t.tick();
  await t.tick();
  expect(t.events("upstream_outage_session_added")).toHaveLength(2);
  expect(t.sent).toHaveLength(2);
  expect(t.events("run_inactive")).toEqual([]);
  // The third drop is past the default limit of two.
  t.stuck.add(terminal);
  t.f.advance(11 * 60_000);
  await t.tick();
  await t.tick();
  expect(t.events("upstream_outage_session_added")).toHaveLength(2);
  expect(t.sent).toHaveLength(2);
  expect(t.events("run_inactive")).toHaveLength(1);
  expect(t.events("run_inactive")[0]?.payload).toMatchObject({
    run_id: t.targets[0]!.run.id,
    reason: "mcp_inactivity",
  });
  for (let m = 0; m < 3; m++) {
    t.f.advance(61_000);
    await t.tick();
  }
  expect(t.sent).toHaveLength(2);
});

test("C-842: a disconnect client recovery already took is left to it", async () => {
  const t = outage(1, "disconnect");
  const [{ a, run }] = t.targets as [{ a: Assignment; run: Run }];
  t.f.store.uow.run((tx) =>
    tx.events.append(t.f.project, {
      id: tx.ids.nextEventId(),
      seq: tx.ids.nextEventSequence(t.f.project),
      type: "client_resume_claimed",
      actor: { kind: "system", project_id: t.f.project },
      payload: { assignment_id: a.id, run_id: run.id },
      created_at: t.f.clock.now(),
    }),
  );
  t.recover();
  await t.tick();
  await t.tick();
  expect(t.events("upstream_outage_session_added")).toEqual([]);
  expect(t.sent).toEqual([]);
  expect(t.events("run_inactive")).toHaveLength(1);
});
