import { acknowledgeRun, type Runtime } from "@cardigan/domain";
import { armBellReceipt, confirmBellWrite } from "@cardigan/host";
import { expect, onTestFinished, test, vi } from "vitest";
import { recoveryFixture } from "../test-support/recovery.js";
import { sharedRepairStore } from "../test-support/shared-repair.js";
import { Dispatcher } from "./dispatch.js";

test("a proven guard refusal preserves the first write across the dispatch timeout and restart", async () => {
  const f = recoveryFixture();
  onTestFinished(f.close);
  let busy = false,
    refuseNext = true;
  vi.mocked(f.runtime.status).mockImplementation(async () => ({
    ok: true,
    value: {
      process: "alive",
      agent: busy ? "working" : "done",
      observed_seq: 2,
    },
  }));
  const writes: string[] = [];
  vi.mocked(f.runtime.wake).mockImplementation(async (_, text, opts) => {
    if (refuseNext) {
      // Dispatch preceded the slot refusal; their deadlines are not the same.
      f.advance(500);
      busy = true;
      refuseNext = false;
    }
    if (busy || !opts?.before_send?.())
      return { ok: true, value: { sent: false, withdrawn: true } };
    writes.push(text);
    return { ok: true, value: { sent: true } };
  });
  const opts = { ...f.options, dispatchTimeoutMs: 1000 };
  f.comment();
  await new Dispatcher(opts).tick();
  const id = f.latest().id;
  expect(f.latest().bell_delivery?.refused_attempt_id).toBeTruthy();
  f.advance(501);
  await new Dispatcher(opts).tick();
  expect(f.runtime.release).not.toHaveBeenCalled();
  expect(writes).toHaveLength(0);
  busy = false;
  await new Dispatcher(opts).tick();
  expect(writes).toHaveLength(1);
  expect(writes[0]).toContain(`run=${id}`);
  expect(f.latest().bell_delivery).toMatchObject({ sent_at: f.clock.now() });
  expect(f.latest().bell_delivery?.retry_at).toBeUndefined();
  expect(f.notes()).toEqual([
    expect.objectContaining({ run_id: id, status: "belled" }),
  ]);
  f.apply(
    (s, a, p) => acknowledgeRun(s, a, { run_id: id }, p),
    f.actorFor(f.target.assignment),
  );
  for (let i = 0; i < 3; i++) {
    f.advance(1001);
    await new Dispatcher(opts).tick();
  }
  expect(f.latest().bell_delivery?.escalated_at).toBeTruthy();
  expect(writes).toHaveLength(2);
  f.comment();
  await new Dispatcher(opts).tick();
  expect(writes).toHaveLength(3);
  expect(f.notes().every((n) => n.status === "belled" && n.run_id === id)).toBe(
    true,
  );
});

test.each(["probe", "send slot"])(
  "a first write refused at the %s is handed off without sending an empty bell later",
  async (boundary) => {
    const f = recoveryFixture();
    onTestFinished(f.close);
    vi.mocked(f.runtime.wake).mockResolvedValue({
      ok: true,
      value: { sent: false, withdrawn: true },
    });
    const tick = () =>
      new Dispatcher({ ...f.options, dispatchTimeoutMs: 1000 }).tick();
    f.comment();
    await tick();
    const id = f.latest().id;
    expect(f.latest().bell_delivery?.refused_attempt_id).toBeTruthy();
    if (boundary === "probe")
      f.working.add(f.refFor(f.target.assignment).terminal_ref);
    await tick();
    f.advance(1000);
    await tick();
    const attempts = vi.mocked(f.runtime.wake).mock.calls.length;
    f.working.clear();
    await tick();
    expect(f.notes()).toMatchObject([{ status: "needs_attention" }]);
    expect(
      f.state().events.filter((e) => e.type === "bell_wake_escalated"),
    ).toMatchObject([
      {
        payload: {
          run_id: id,
          reason: "first_write_guard",
          notification_ids: [f.notes()[0]?.id],
        },
      },
    ]);
    expect(f.runtime.wake).toHaveBeenCalledTimes(attempts);
    expect(f.runtime.release).not.toHaveBeenCalled();
  },
);

test("the cold publication boundary pins ordinary rework; supersession retires it without replay", () =>
  checkSupersession("cold write"));
test("supersession after first write handoff retires ordinary rework without replay", () =>
  checkSupersession("first write handoff"));

async function checkSupersession(
  boundary: "cold write" | "first write handoff",
) {
  const f = await sharedRepairStore();
  const initial = f.read();
  const owner = initial.assignments.find((a) => a.id === f.owner);
  const review = initial.events.findLast((e) => e.type === "review_submitted");
  if (!owner?.runtime_ref || !review) throw Error("missing review context");
  let exited = false;
  const opts = {
    store: f.store,
    clock: f.clock,
    dispatchTimeoutMs: 1000,
    runtime: {
      status: vi.fn(async () => ({
        ok: true,
        value: {
          process: exited ? "exited" : "alive",
          agent: "idle",
          observed_seq: 1,
        },
      })),
      wake: vi.fn(async () => ({
        ok: true,
        value:
          boundary === "cold write"
            ? { sent: true }
            : { sent: false, withdrawn: true },
      })),
      release: vi.fn(async () => {
        exited = true;
        return { ok: true as const, value: undefined };
      }),
      interrupt: vi.fn(),
      provision: vi.fn(),
      resume_or_replace: vi.fn(),
      human_entry: vi.fn(),
    } satisfies Runtime,
    snapshot: async () => ({ model: "fixture", agent_cli_version: "1" }),
    startRun: vi.fn(),
  };
  await new Dispatcher(opts).tick();
  const run = f
    .read()
    .runs.find(
      (r) =>
        r.assignment_id === f.owner &&
        r.kind === "rework" &&
        r.status === "dispatched",
    );
  if (!run) throw Error("missing dispatched repair");
  if (boundary === "cold write") {
    // A cold launch has no live BellAttempt binding to pass into this boundary.
    expect(
      armBellReceipt(
        f.store,
        f.project,
        run.id,
        owner.runtime_ref,
        review.card_id,
      ),
    ).toBe(true);
    confirmBellWrite(f.store, f.project, run.id, f.clock.now());
    expect(
      f.read().runs.find((r) => r.id === run.id)?.bell_delivery?.review_target,
    ).toEqual({
      delivery_id: f.target.id,
      target_sha: f.target.subject.value,
    });
  } else {
    const waitEvents = () =>
      f
        .read()
        .events.filter(
          (e) =>
            ["bell_wake_deferred", "bell_wake_escalated"].includes(e.type) &&
            (e.payload as { run_id?: string }).run_id === run.id,
        )
        .map((e) => e.type);
    expect(waitEvents()).toEqual(["bell_wake_deferred"]);
    f.advance(1001);
    await new Dispatcher(opts).tick();
    expect(waitEvents()).toEqual(["bell_wake_deferred", "bell_wake_escalated"]);
  }
  f.store.uow.run((tx) =>
    tx.deliveries.put(f.project, { ...f.target, status: "superseded" }),
  );
  expect(armBellReceipt(f.store, f.project, run.id, owner.runtime_ref)).toBe(
    false,
  );
  const count = opts.runtime.wake.mock.calls.length;
  f.advance(1001);
  await new Dispatcher(opts).tick();
  expect(opts.runtime.wake).toHaveBeenCalledTimes(count);
  expect(f.read().runs.find((r) => r.id === run.id)?.status).toBe("cancelled");
  expect(
    f
      .read()
      .runs.filter(
        (r) => r.recovery_policy?.root_run_id === run.id && r.id !== run.id,
      ),
  ).toEqual([]);
}
