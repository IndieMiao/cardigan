import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { acknowledgeRun, postComment, type Runtime } from "@cardigan/domain";
import { loadRunCapacityConfig, MachineLeases } from "@cardigan/host";
import { loadCommandState } from "@cardigan/mcp-server";
import { expect, test, vi } from "vitest";
import { dispatchFixture } from "../test-support/dispatch.js";
import { recoveryFixture } from "../test-support/recovery.js";
import { checkBellReceipts } from "./bell-receipt.js";
import { Dispatcher } from "./dispatch.js";

async function configuredLeases(
  f: ReturnType<typeof dispatchFixture>,
  machine: string,
) {
  await writeFile(
    join(f.dataDir, "run-capacity.yaml"),
    JSON.stringify({
      machines: { [machine]: { limit: 1, preferred_project: f.project } },
    }),
    { mode: 0o600 },
  );
  const leases = new MachineLeases(
    f.store,
    await loadRunCapacityConfig({ configDir: f.dataDir }),
    vi.fn(),
  );
  expect(leases.configured(f.project, machine)).toBe(true);
  return leases;
}

// Count writes at the adapter boundary, not wake() invocations. The same port
// receives the exact worker binding for remote terminals; no local fallback.
test.each([
  ["local", false],
  ["worker", true],
] as const)(
  "%s: retry a confirmed write once on its original Run, then tell PM",
  async (machine, businessStarted) => {
    const f = dispatchFixture(machine);
    try {
      const t = f.create();
      f.session(t.assignment);
      f.apply((s, a, p) =>
        postComment(
          s,
          a,
          { card_id: t.card.id, work_item_id: t.item.id, body: "unread" },
          p,
        ),
      );
      let agent: "working" | "idle" | "done" = "working";
      const writes: string[] = [];
      const runtime: Runtime = {
        status: vi.fn(async () => ({
          ok: true as const,
          value: { process: "alive" as const, agent, observed_seq: 2 },
        })),
        wake: vi.fn(async (ref, text, opts) => {
          expect(ref).toEqual(f.refFor(t.assignment));
          if (writes.length)
            expect(
              opts?.if_idle || opts?.observed_guard?.state === "done",
            ).toBe(true);
          if (
            (opts?.resource_preflight && !(await opts.resource_preflight())) ||
            !opts?.before_send?.()
          )
            return {
              ok: true as const,
              value: { sent: false, withdrawn: true as const },
            };
          writes.push(text);
          return { ok: true as const, value: { sent: true } };
        }),
        release: vi.fn(),
        provision: vi.fn(),
        resume_or_replace: vi.fn(),
        interrupt: vi.fn(),
        human_entry: vi.fn(),
      };
      const leases = await configuredLeases(f, machine);
      const opts = {
        leases,
        store: f.store,
        clock: f.clock,
        runtime,
        dispatchTimeoutMs: 1000,
        snapshot: vi.fn(),
        startRun: vi.fn(),
      };
      const dispatch = new Dispatcher(opts);
      await dispatch.tick();
      // The previous business Run finished explicitly. Only a retry or continuation requires idle.
      expect(writes).toHaveLength(1);
      const id = f.state().runs.at(-1)?.id;
      if (!id) throw new Error("missing Run");
      if (businessStarted)
        f.apply(
          (s, a, p) => acknowledgeRun(s, a, { run_id: id }, p),
          f.actorFor(t.assignment),
        );
      f.advance(999);
      await dispatch.tick();
      expect(writes).toHaveLength(1);
      f.advance(1);
      agent = "idle";
      await Promise.all([new Dispatcher(opts).tick(), dispatch.tick()]);
      expect(writes).toHaveLength(2);
      expect(writes.every((text) => text.includes(`run=${id}`))).toBe(true);
      f.advance(1001);
      await new Dispatcher(opts).tick();
      await dispatch.tick();
      expect(writes).toHaveLength(2);
      expect(runtime.release).not.toHaveBeenCalled();
      const evidence = f
        .state()
        .events.filter((e) => e.type === "bell_receipt_missing");
      expect(evidence).toHaveLength(1);
      expect(evidence[0]?.payload).toMatchObject({
        assignment_id: t.assignment.id,
        run_id: id,
        reason: "no_receipt_after_retry",
        activity_source: `${machine}: alive/idle`,
      });
      expect(
        f.store
          .listNotifications({ project_id: f.project })
          .some(
            (n) =>
              n.event_id === evidence[0]?.id && n.recipient.kind === "pm_ops",
          ),
      ).toBe(true);
      if (businessStarted) {
        f.apply((s, a, p) =>
          postComment(
            s,
            a,
            {
              card_id: t.card.id,
              work_item_id: t.item.id,
              body: "PM follow-up",
            },
            p,
          ),
        );
        agent = "working";
        await dispatch.tick();
        expect(writes).toHaveLength(2);
        agent = "idle";
        await dispatch.tick();
        expect(writes).toHaveLength(3);
        expect(writes[2]).toContain(`run=${id}`);
        expect(
          f.state().runs.at(-1)?.bell_delivery?.received_at,
        ).toBeUndefined();
      }
    } finally {
      f.close();
    }
  },
);

test.each(["running", "dispatched"] as const)(
  "%s: a refused resource check informs PM once without consuming a write",
  async (phase) => {
    const f = recoveryFixture("worker");
    try {
      const leases = await configuredLeases(f, "worker");
      let writes = 0;
      vi.mocked(f.runtime.wake).mockImplementation(
        async (_ref, _bell, opts) => {
          if (
            (opts?.resource_preflight && !(await opts.resource_preflight())) ||
            !opts?.before_send?.()
          )
            return { ok: true, value: { sent: false, withdrawn: true } };
          writes++;
          return { ok: true, value: { sent: true } };
        },
      );
      const dispatcher = new Dispatcher({
        ...f.options,
        leases,
        dispatchTimeoutMs: 1000,
      });
      f.comment();
      await dispatcher.tick();
      const id = f.latest().id;
      if (phase === "running") {
        f.apply(
          (s, a, p) => acknowledgeRun(s, a, { run_id: id }, p),
          f.actorFor(f.target.assignment),
        );
        vi.spyOn(leases, "startBlocked").mockReturnValue("grant unavailable");
      } else vi.spyOn(leases, "canPublish").mockResolvedValue(false);
      f.advance(1000);
      await dispatcher.tick();
      await dispatcher.tick();
      expect(writes).toBe(1);
      expect(f.latest().bell_delivery?.retry_at).toBeUndefined();
      expect(
        f
          .state()
          .events.filter((e) => e.type === "bell_receipt_missing")
          .map((e) => e.payload),
      ).toEqual([
        expect.objectContaining({ run_id: id, reason: "retry_withdrawn" }),
      ]);
    } finally {
      f.close();
    }
  },
);

test.each([
  "slot refusal",
  "refusal after reservation",
  "start during status",
  "start during preflight",
  "lost reply",
] as const)("remote receipt retry: %s", async (scenario) => {
  const f = recoveryFixture("worker");
  try {
    const leases = await configuredLeases(f, "worker");
    const start = () => {
      const id = f.latest().id;
      return f.apply(
        (s, a, p) => acknowledgeRun(s, a, { run_id: id }, p),
        f.actorFor(f.target.assignment),
      );
    };
    let writes = 0,
      retry = false,
      raced = false;
    const opts = { ...f.options, leases, dispatchTimeoutMs: 1000 };
    vi.mocked(f.runtime.status).mockImplementation(async () => {
      if (retry && scenario === "start during status" && !raced) {
        raced = true;
        start();
      }
      return {
        ok: true,
        value: { process: "alive", agent: "done", observed_seq: 1 },
      };
    });
    vi.mocked(f.runtime.wake).mockImplementation(async (_ref, _bell, gates) => {
      if (retry) expect(gates?.observed_guard?.state).toBe("done");
      if (gates?.resource_preflight && !(await gates.resource_preflight()))
        return { ok: true, value: { sent: false, withdrawn: true } };
      if (retry && !raced && scenario === "slot refusal") {
        raced = true;
        return { ok: true, value: { sent: false, withdrawn: true } };
      }
      if (!gates?.before_send?.())
        return { ok: true, value: { sent: false, withdrawn: true } };
      if (retry && !raced && scenario === "refusal after reservation") {
        raced = true;
        return { ok: true, value: { sent: false, withdrawn: true } };
      }
      writes++;
      if (retry && scenario === "lost reply")
        return {
          ok: false,
          error: { code: "runtime_timeout", message: "no response" },
        };
      return { ok: true, value: { sent: true } };
    });
    f.comment();
    await new Dispatcher(opts).tick();
    expect(writes).toBe(1);
    if (scenario === "start during preflight")
      vi.spyOn(leases, "canPublish").mockImplementationOnce(async () => {
        raced = true;
        start();
        return false;
      });
    else if (scenario !== "start during status") start();
    retry = true;
    f.advance(1000);
    await checkBellReceipts(
      opts,
      f.project,
      f.state(),
      loadCommandState,
      f.clock,
      1000,
      () => false,
    );
    if (scenario.includes("refusal")) {
      expect(writes).toBe(1);
      expect(f.latest().bell_delivery?.retry_at).toBeUndefined();
    }
    if (scenario !== "lost reply") expect(raced).toBe(true);
    expect(f.latest().bell_delivery?.escalated_at).toBeUndefined();
    for (let i = 0; i < 3; i++) {
      f.advance(1000);
      await new Dispatcher(opts).tick();
    }
    expect(writes).toBe(2);
    expect(f.latest().bell_delivery?.retry_at).toBeTruthy();
    expect(
      f
        .state()
        .events.filter((e) => e.type === "bell_receipt_missing")
        .map((e) => e.payload),
    ).toEqual([expect.objectContaining({ reason: "no_receipt_after_retry" })]);
  } finally {
    f.close();
  }
});
