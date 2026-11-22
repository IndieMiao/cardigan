import { beforeEach, expect, test } from "vitest";
import {
  acknowledgeRun,
  claimDispatchStop,
  dispatchRun,
  MCP_SESSION_FAILURE,
  type McpHandshake,
  type Run,
  recoverDispatch,
  startDispatchStop,
} from "../index.js";
import {
  actor,
  commit,
  f,
  queue,
  ref,
  setup,
  system,
} from "./launch/test-fixtures.js";
import { notices } from "./notices.js";

let now: number;
beforeEach(() => {
  setup();
  now = Date.parse(f.io.clock.now());
  f.io = { ...f.io, clock: { now: () => new Date(now).toISOString() } };
});

/** Launch a fresh session, optionally requiring the C-600 handshake. */
const launch = (r: Run, verify = true, terminal = "t1") =>
  commit(
    dispatchRun(
      f.state,
      system,
      {
        run_id: r.id,
        runtime_ref: { ...ref, terminal_ref: terminal },
        ...(verify ? { verify_mcp_session: true as const } : {}),
        base_sha: "a".repeat(40),
      },
      f.io,
    ),
  );
const coder = () => {
  const a = f.state.assignments.find((x) => x.id === f.coder.id);
  if (!a) throw new Error("Missing coder");
  return a;
};
/** What the MCP endpoint records (Store.advanceMcpHandshake). */
const observe = (mcp_handshake: McpHandshake) => {
  f.state = {
    ...f.state,
    assignments: f.state.assignments.map((a) =>
      a.id === f.coder.id ? { ...a, mcp_handshake } : a,
    ),
  };
};
const stop = (r: Run) => {
  const claimed = commit(
    claimDispatchStop(
      f.state,
      system,
      { run_id: r.id, reason: "mcp_unavailable", lease_ms: 60000 },
      f.io,
    ),
  );
  if (!claimed?.dispatch_stop) return undefined;
  commit(
    startDispatchStop(
      f.state,
      system,
      { run_id: r.id, attempt_id: claimed.dispatch_stop.attempt_id },
      f.io,
    ),
  );
  return f.state.runs.find((x) => x.id === r.id)?.dispatch_stop;
};
const recover = (r: Run, fence = f.state.runs.find((x) => x.id === r.id)) =>
  recoverDispatch(
    f.state,
    system,
    {
      run_id: r.id,
      timeout_ms: 600000,
      failed_attempts: 0,
      max_failures: 5,
      ...(fence?.dispatch_stop
        ? {
            stop_id: fence.dispatch_stop.attempt_id,
            stopped_runtime: fence.dispatch_stop.runtime_ref,
          }
        : {}),
    },
    f.io,
  );

test("C-600 only a verified new session waits for its native tool listing; a reused session keeps its state", () => {
  const first = commit(queue());
  launch(first, false);
  expect(coder().mcp_handshake).toBeUndefined();
  commit(acknowledgeRun(f.state, actor(), { run_id: first.id }, f.io));

  // A later verified launch starts pending, whatever the previous session did.
  observe("listed");
  f.state = {
    ...f.state,
    runs: f.state.runs.map((r) =>
      r.id === first.id
        ? { ...r, status: "completed", outcome: "completed" }
        : r,
    ),
  };
  const second = commit(queue());
  launch(second, true, "t2");
  expect(coder().mcp_handshake).toBe("pending");

  // Unverified relaunches never inherit the old session's handshake.
  observe("missing");
  f.state = {
    ...f.state,
    runs: f.state.runs.map((r) =>
      r.id === second.id ? { ...r, status: "cancelled", outcome: "failed" } : r,
    ),
  };
  const third = commit(queue());
  launch(third, false, "t3");
  expect(coder().mcp_handshake).toBeUndefined();
});

test.each(["pending", "missing"] as const)(
  "C-600 a %s session cannot acknowledge its Run; the native listing can",
  (state) => {
    const r = commit(queue());
    launch(r);
    observe(state);
    expect(
      acknowledgeRun(f.state, actor(), { run_id: r.id }, f.io),
    ).toMatchObject({
      ok: false,
      error: {
        code: "illegal_transition",
        message: expect.stringContaining("MCP 初始化失败"),
      },
    });
    expect(f.state.runs.find((x) => x.id === r.id)?.status).toBe("dispatched");
    if (state === "pending") {
      observe("listed");
      expect(
        commit(acknowledgeRun(f.state, actor(), { run_id: r.id }, f.io)),
      ).toMatchObject({ status: "running" });
    }
  },
);

test("C-600 an MCP stop needs proof the session has no tools and is withdrawn if it lists them", () => {
  const r = commit(queue());
  launch(r);
  expect(stop(r)).toBeUndefined();
  observe("missing");
  const claimed = commit(
    claimDispatchStop(
      f.state,
      system,
      { run_id: r.id, reason: "mcp_unavailable", lease_ms: 60000 },
      f.io,
    ),
  );
  expect(claimed?.dispatch_stop?.reason).toBe("mcp_unavailable");
  observe("listed");
  expect(
    commit(
      startDispatchStop(
        f.state,
        system,
        {
          run_id: r.id,
          attempt_id: claimed?.dispatch_stop?.attempt_id ?? "",
        },
        f.io,
      ),
    ),
  ).toBe(false);
  expect(
    f.state.runs.find((x) => x.id === r.id)?.dispatch_stop,
  ).toBeUndefined();
  expect(
    f.state.events.findLast((e) => e.type === "run_dispatch_stop_withdrawn")
      ?.payload,
  ).toMatchObject({ reason: "mcp_evidence_changed" });
});

test("C-600 a session without Card tools is rebuilt once, then reported in Needs You with a readable reason", () => {
  const r = commit(queue());
  launch(r);
  observe("missing");
  // No timeout is needed: the missing handshake is the evidence.
  const fence = stop(r);
  expect(fence?.reason).toBe("mcp_unavailable");
  const replacement = commit(recover(r));
  expect(replacement).toMatchObject({ status: "queued" });
  expect(f.state.runs.find((x) => x.id === r.id)).toMatchObject({
    status: "cancelled",
    summary: expect.stringContaining(MCP_SESSION_FAILURE),
  });
  expect(
    f.state.events.find((e) => e.type === "run_dispatch_recovered")?.payload,
  ).toMatchObject({
    reason: "mcp_unavailable",
    body: expect.stringContaining("MCP 初始化失败"),
  });
  expect(coder().runtime_ref).toBeNull();
  if (!replacement) throw new Error("Missing replacement");

  // The rebuilt session also comes up without Card tools.
  launch(replacement, true, "t2");
  expect(coder().mcp_handshake).toBe("pending");
  observe("missing");
  commit(recover(replacement));
  const stalled = f.state.events.find((e) => e.type === "run_dispatch_stalled");
  expect(stalled?.payload).toMatchObject({
    run_id: replacement.id,
    reason: "mcp_unavailable",
    audience: "needs_you",
    body: expect.stringContaining("MCP 初始化失败"),
  });
  expect(f.state.human_actions).toEqual([
    expect.objectContaining({
      status: "open",
      instructions: expect.stringContaining("机器检查"),
    }),
  ]);
  expect(notices(f.state)).toEqual([
    expect.objectContaining({
      option: "会话 MCP 初始化失败",
      body: expect.stringContaining("MCP 初始化失败"),
      resolved_by: "system",
    }),
  ]);
  // Repeated observation never escalates twice.
  expect(commit(recover(replacement))).toBeUndefined();
  expect(
    f.state.events.filter((e) => e.type === "mcp_session_failed"),
  ).toHaveLength(1);
});
