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

const KEY = (n: number) => String(n).repeat(64).slice(0, 64);
/** Launch a fresh session, optionally requiring the C-600 handshake. */
const launch = (r: Run, verify = true, terminal = "t1") =>
  commit(
    dispatchRun(
      f.state,
      system,
      {
        run_id: r.id,
        runtime_ref: { ...ref, terminal_ref: terminal },
        ...(verify
          ? { verify_mcp_session: { key_sha256: KEY(Number(r.id.slice(2))) } }
          : {}),
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
const finished = (r: Run, status: Run["status"]) => {
  f.state = {
    ...f.state,
    runs: f.state.runs.map((x) =>
      x.id === r.id ? { ...x, status, outcome: "completed" } : x,
    ),
  };
};
/** Claim and start the MCP stop; returns the fence or undefined. */
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
/** Settle after the host's exit proof (or its failure to get one). */
const recover = (r: Run, stopFailed = false) => {
  const fence = f.state.runs.find((x) => x.id === r.id)?.dispatch_stop;
  return recoverDispatch(
    f.state,
    system,
    {
      run_id: r.id,
      timeout_ms: 600000,
      failed_attempts: 0,
      max_failures: 5,
      ...(fence
        ? {
            stop_id: fence.attempt_id,
            ...(stopFailed
              ? { stop_failed: true }
              : { stopped_runtime: fence.runtime_ref }),
          }
        : {}),
    },
    f.io,
  );
};
/** First failure: stopped and rebuilt once; returns the queued replacement. */
const firstFailure = () => {
  const r = commit(queue());
  launch(r);
  observe("missing");
  stop(r);
  const replacement = commit(recover(r));
  if (!replacement) throw new Error("Missing replacement");
  return { first: r, replacement };
};

test("C-600 only a verified new session waits for this launch's tool listing; a reused session keeps its state", () => {
  const first = commit(queue());
  launch(first, false);
  expect(coder()).not.toHaveProperty("mcp_handshake");
  commit(acknowledgeRun(f.state, actor(), { run_id: first.id }, f.io));

  finished(first, "completed");
  const second = commit(queue());
  launch(second, true, "t2");
  expect(coder()).toMatchObject({
    mcp_handshake: "pending",
    mcp_session_key_sha256: KEY(Number(second.id.slice(2))),
  });

  // A Run on the same terminal belongs to the same session.
  observe("listed");
  commit(acknowledgeRun(f.state, actor(), { run_id: second.id }, f.io));
  finished(second, "completed");
  const reused = commit(queue());
  commit(dispatchRun(f.state, system, { run_id: reused.id }, f.io));
  expect(coder()).toMatchObject({
    mcp_handshake: "listed",
    mcp_session_key_sha256: KEY(Number(second.id.slice(2))),
  });

  // Unverified relaunches never inherit the old session's handshake or key.
  commit(acknowledgeRun(f.state, actor(), { run_id: reused.id }, f.io));
  finished(reused, "completed");
  const third = commit(queue());
  launch(third, false, "t3");
  expect(coder()).not.toHaveProperty("mcp_handshake");
  expect(coder()).not.toHaveProperty("mcp_session_key_sha256");
});

test("C-600 verification needs a new session and a SHA-256 key digest", () => {
  const r = commit(queue());
  for (const p of [
    { runtime_ref: ref, verify_mcp_session: { key_sha256: "not-a-digest" } },
    { verify_mcp_session: { key_sha256: KEY(1) } },
  ])
    expect(
      dispatchRun(
        f.state,
        system,
        { run_id: r.id, base_sha: "a".repeat(40), ...p },
        f.io,
      ),
    ).toMatchObject({ ok: false, error: { code: "validation_failed" } });
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

test("C-600 a session without Card tools is rebuilt once; the rebuilt one is stopped, settled as a failed start and reported", () => {
  const { first, replacement } = firstFailure();
  expect(replacement).toMatchObject({ status: "queued" });
  expect(f.state.runs.find((x) => x.id === first.id)).toMatchObject({
    status: "cancelled",
    outcome: "failed",
    failure_reason: "mcp_unavailable",
    summary: expect.stringContaining(MCP_SESSION_FAILURE),
  });
  expect(
    f.state.events.find((e) => e.type === "run_dispatch_recovered")?.payload,
  ).toMatchObject({
    reason: "mcp_unavailable",
    body: expect.stringContaining("MCP 初始化失败"),
  });
  expect(coder().runtime_ref).toBeNull();

  // The rebuilt session also comes up without Card tools.
  launch(replacement, true, "t2");
  expect(coder().mcp_handshake).toBe("pending");
  observe("missing");
  // No settlement without the stop fence and exit proof.
  expect(commit(recover(replacement))).toBeUndefined();
  expect(f.state.events.some((e) => e.type === "run_dispatch_stalled")).toBe(
    false,
  );
  expect(f.state.runs.find((x) => x.id === replacement.id)?.status).toBe(
    "dispatched",
  );
  expect(stop(replacement)?.reason).toBe("mcp_unavailable");
  expect(commit(recover(replacement))).toBeUndefined();
  expect(f.state.runs.find((x) => x.id === replacement.id)).toMatchObject({
    status: "cancelled",
    outcome: "failed",
    failure_reason: "mcp_unavailable",
    summary: expect.stringContaining("记为启动失败"),
  });
  expect(f.state.runs.find((x) => x.id === replacement.id)).not.toHaveProperty(
    "dispatch_stop",
  );
  expect(coder().runtime_ref).toBeNull();
  // No third launch is queued.
  expect(f.state.runs.filter((r) => r.status === "queued")).toEqual([]);
  const stalled = f.state.events.filter(
    (e) => e.type === "run_dispatch_stalled",
  );
  expect(stalled).toHaveLength(1);
  expect(stalled[0]?.payload).toMatchObject({
    run_id: replacement.id,
    reason: "mcp_unavailable",
    audience: "needs_you",
    body: expect.stringContaining("已确认终端退出并记为启动失败"),
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

test("C-600 an unconfirmed stop of the rebuilt session keeps its fence and never queues a third launch", () => {
  const { replacement } = firstFailure();
  launch(replacement, true, "t2");
  observe("missing");
  const fence = stop(replacement);
  expect(fence).toBeDefined();
  commit(recover(replacement, true));
  expect(f.state.runs.find((x) => x.id === replacement.id)).toMatchObject({
    status: "dispatched",
    dispatch_stop: expect.objectContaining({ stopping: true }),
  });
  expect(coder().runtime_ref).not.toBeNull();
  expect(f.state.runs.filter((r) => r.status === "queued")).toEqual([]);
  expect(
    f.state.events.findLast((e) => e.type === "run_dispatch_stalled")?.payload,
  ).toMatchObject({
    reason: "mcp_unavailable",
    body: expect.stringContaining("无法确认旧终端已停止"),
  });
});
