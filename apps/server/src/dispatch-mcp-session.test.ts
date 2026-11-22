import { dispatchRun, notices, postComment } from "@cardigan/domain";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { recoveryFixture } from "../test-support/recovery.js";
import { Dispatcher, type DispatcherOptions } from "./dispatch.js";

let f: ReturnType<typeof recoveryFixture>;
beforeEach(() => {
  f = recoveryFixture();
});
afterEach(() => f.close());

/** C-600: the host launches every new session with the handshake check on. */
function verifiedOptions(): DispatcherOptions {
  let generation = 0;
  return {
    ...f.options,
    startRun: vi.fn(async ({ run, assignment }) => {
      const ref = {
        ...f.refFor(assignment),
        terminal_ref: `fresh-${++generation}`,
      };
      f.apply((s, a, p) =>
        dispatchRun(
          s,
          a,
          { run_id: run.id, runtime_ref: ref, verify_mcp_session: true },
          p,
        ),
      );
    }),
  };
}

test("C-600 a session without native Card tools is rebuilt at once, then reported in Needs You", async () => {
  const t = f.create();
  const runs = () =>
    f.state().runs.filter((r) => r.assignment_id === t.assignment.id);
  const handshake = () =>
    f.state().assignments.find((a) => a.id === t.assignment.id)?.mcp_handshake;
  const options = verifiedOptions();
  const d = new Dispatcher(options);
  f.apply((s, a, p) =>
    postComment(
      s,
      a,
      { card_id: t.card.id, work_item_id: t.item.id, body: "Start" },
      p,
    ),
  );
  await d.tick();
  const first = runs().at(-1);
  expect(first?.status).toBe("dispatched");
  expect(handshake()).toBe("pending");

  // The Agent reached the endpoint only through a wrapper: no tools/list.
  expect(
    f.store.advanceMcpHandshake(f.project, t.assignment.id, "tool_called"),
  ).toBe("missing");
  // No dispatch timeout elapses: the evidence alone stops and requeues it.
  for (let i = 0; i < 3 && runs().length < 2; i++) await d.tick();
  expect(f.runtime.release).toHaveBeenCalled();
  expect(runs().find((r) => r.id === first?.id)).toMatchObject({
    status: "cancelled",
    summary: expect.stringContaining("MCP 初始化失败"),
  });
  expect(
    f.state().events.find((e) => e.type === "run_dispatch_recovered")?.payload,
  ).toMatchObject({ run_id: first?.id, reason: "mcp_unavailable" });

  // The single rebuild launches a fresh, again verified session.
  for (let i = 0; i < 3 && runs().at(-1)?.status !== "dispatched"; i++)
    await d.tick();
  const second = runs().at(-1);
  expect(second?.id).not.toBe(first?.id);
  expect(second?.status).toBe("dispatched");
  expect(options.startRun).toHaveBeenCalledTimes(2);
  expect(handshake()).toBe("pending");

  f.store.advanceMcpHandshake(f.project, t.assignment.id, "tool_called");
  await d.tick();
  await d.tick();
  expect(runs()).toHaveLength(2);
  const stalled = f
    .state()
    .events.filter((e) => e.type === "run_dispatch_stalled");
  expect(stalled).toHaveLength(1);
  expect(stalled[0]?.payload).toMatchObject({
    run_id: second?.id,
    reason: "mcp_unavailable",
    body: expect.stringContaining("MCP 初始化失败"),
  });
  expect(
    notices(f.state()).filter((n) => n.option === "会话 MCP 初始化失败"),
  ).toHaveLength(1);
});

test("C-600 a session that listed its tools is never stopped for MCP", async () => {
  const t = f.create();
  const d = new Dispatcher(verifiedOptions());
  f.apply((s, a, p) =>
    postComment(
      s,
      a,
      { card_id: t.card.id, work_item_id: t.item.id, body: "Start" },
      p,
    ),
  );
  await d.tick();
  expect(
    f.store.advanceMcpHandshake(f.project, t.assignment.id, "tools_listed"),
  ).toBe("listed");
  f.store.advanceMcpHandshake(f.project, t.assignment.id, "tool_called");
  await d.tick();
  await d.tick();
  expect(f.runtime.release).not.toHaveBeenCalled();
  expect(
    f.state().events.some((e) => e.type === "run_dispatch_stop_requested"),
  ).toBe(false);
});
