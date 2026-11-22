import {
  type AssignmentId,
  DEFAULT_MCP_HANDSHAKE_TIMEOUT_MS,
  dispatchRun,
  notices,
  postComment,
} from "@cardigan/domain";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { recoveryFixture } from "../test-support/recovery.js";
import { Dispatcher, type DispatcherOptions } from "./dispatch.js";

let f: ReturnType<typeof recoveryFixture>;
beforeEach(() => {
  f = recoveryFixture();
});
afterEach(() => f.close());

const digest = (n: number) => String(n % 10).repeat(64);
/** C-600: the host launches every new session with the handshake check on. */
function verifiedOptions(extra: Partial<DispatcherOptions> = {}) {
  let generation = 0;
  const options: DispatcherOptions = {
    ...f.options,
    ...extra,
    startRun: vi.fn(async ({ run, assignment }) => {
      generation++;
      const ref = {
        ...f.refFor(assignment),
        terminal_ref: `fresh-${generation}`,
      };
      f.apply((s, a, p) =>
        dispatchRun(
          s,
          a,
          {
            run_id: run.id,
            runtime_ref: ref,
            verify_mcp_session: {
              key_sha256: digest(generation),
              token_id: `token-${generation}`,
            },
          },
          p,
        ),
      );
    }),
  };
  return options;
}
function start() {
  const t = f.create();
  f.apply((s, a, p) =>
    postComment(
      s,
      a,
      { card_id: t.card.id, work_item_id: t.item.id, body: "Start" },
      p,
    ),
  );
  const runs = () =>
    f.state().runs.filter((r) => r.assignment_id === t.assignment.id);
  const owner = () =>
    f.state().assignments.find((a) => a.id === t.assignment.id);
  return { t, runs, owner };
}
async function untilDispatched(
  d: Dispatcher,
  runs: () => readonly { id: string; status: string }[],
  previous?: string,
) {
  for (let i = 0; i < 4; i++) {
    const last = runs().at(-1);
    if (last && last.id !== previous && last.status === "dispatched") return;
    await d.tick();
  }
}
/** Both sessions failed: each was stopped once, the second settled as failed. */
function expectSettledAndReported(
  runs: () => readonly import("@cardigan/domain").Run[],
  id: AssignmentId,
) {
  const all = runs();
  expect(all).toHaveLength(2);
  for (const run of all)
    expect(run).toMatchObject({
      status: "cancelled",
      outcome: "failed",
      failure_reason: "mcp_unavailable",
      summary: expect.stringContaining("MCP 初始化失败"),
    });
  expect(f.runtime.release).toHaveBeenCalledTimes(2);
  expect(
    f.state().assignments.find((a) => a.id === id)?.runtime_ref,
  ).toBeNull();
  const stalled = f
    .state()
    .events.filter((e) => e.type === "run_dispatch_stalled");
  expect(stalled).toHaveLength(1);
  expect(stalled[0]?.payload).toMatchObject({
    run_id: all[1]?.id,
    reason: "mcp_unavailable",
    body: expect.stringContaining("MCP 初始化失败"),
  });
  expect(
    notices(f.state()).filter((n) => n.option === "会话 MCP 初始化失败"),
  ).toHaveLength(1);
}

test("C-600 a session that sends nothing is stopped at the handshake deadline, rebuilt once, then settled and reported", async () => {
  const { t, runs, owner } = start();
  const options = verifiedOptions();
  const d = new Dispatcher(options);
  await d.tick();
  const first = runs().at(-1);
  expect(first?.status).toBe("dispatched");
  expect(owner()?.mcp_handshake).toBe("pending");

  // Native initialize never reached the endpoint: no request at all.
  f.advance(DEFAULT_MCP_HANDSHAKE_TIMEOUT_MS - 1);
  await d.tick();
  expect(f.runtime.release).not.toHaveBeenCalled();
  f.advance(1);
  for (let i = 0; i < 3 && runs().length < 2; i++) await d.tick();
  expect(
    f.state().events.find((e) => e.type === "run_dispatch_recovered")?.payload,
  ).toMatchObject({ run_id: first?.id, reason: "mcp_unavailable" });

  await untilDispatched(d, runs, first?.id);
  expect(options.startRun).toHaveBeenCalledTimes(2);
  expect(owner()).toMatchObject({
    mcp_handshake: "pending",
    mcp_session_key_sha256: digest(2),
  });
  f.advance(DEFAULT_MCP_HANDSHAKE_TIMEOUT_MS);
  for (let i = 0; i < 3; i++) await d.tick();
  expectSettledAndReported(runs, t.assignment.id);
  expect(options.startRun).toHaveBeenCalledTimes(2);
});

test("C-600 a configured deadline applies, and a tool call from outside the harness stops the session at once", async () => {
  const { t, runs, owner } = start();
  const options = verifiedOptions({ mcpHandshakeTimeoutMs: 1000 });
  const d = new Dispatcher(options);
  await d.tick();
  f.advance(1000);
  for (let i = 0; i < 3 && runs().length < 2; i++) await d.tick();
  expect(runs()).toHaveLength(2);
  await untilDispatched(d, runs, runs()[0]?.id);
  expect(owner()?.mcp_handshake).toBe("pending");
  // A wrapper on the same Token, before the deadline.
  expect(
    f.store.advanceMcpHandshake(f.project, t.assignment.id, "tool_called"),
  ).toBe("missing");
  for (let i = 0; i < 3; i++) await d.tick();
  expectSettledAndReported(runs, t.assignment.id);
});

test("C-600 a session whose harness listed its tools is never stopped for MCP", async () => {
  const { t } = start();
  const d = new Dispatcher(verifiedOptions());
  await d.tick();
  expect(
    f.store.advanceMcpHandshake(
      f.project,
      t.assignment.id,
      "tools_listed",
      digest(1),
    ),
  ).toBe("listed");
  f.store.advanceMcpHandshake(f.project, t.assignment.id, "tool_called");
  f.advance(DEFAULT_MCP_HANDSHAKE_TIMEOUT_MS);
  await d.tick();
  await d.tick();
  expect(f.runtime.release).not.toHaveBeenCalled();
  expect(
    f.state().events.some((e) => e.type === "run_dispatch_stop_requested"),
  ).toBe(false);
});

test("C-600 a dispatch timeout shorter than the handshake deadline still names the MCP failure, once", async () => {
  const { t, runs } = start();
  const options = verifiedOptions({ dispatchTimeoutMs: 60_000 });
  const d = new Dispatcher(options);
  await d.tick();
  f.advance(60_000);
  for (let i = 0; i < 3 && runs().length < 2; i++) await d.tick();
  expect(
    f.state().events.find((e) => e.type === "run_dispatch_recovered")?.payload,
  ).toMatchObject({ reason: "mcp_unavailable" });
  await untilDispatched(d, runs, runs()[0]?.id);
  f.advance(60_000);
  for (let i = 0; i < 4; i++) await d.tick();
  expectSettledAndReported(runs, t.assignment.id);
});
