import { describe, expect, test } from "vitest";
import type { Employee } from "../employee.js";
import {
  DEFAULT_UPSTREAM_POLICY,
  diagnoseUpstream,
  type UpstreamTarget,
} from "../upstream-health.js";
import {
  resolveUpstreamOutagePolicy,
  runAwaitingUpstreamResume,
  runHeldByUpstreamOutage,
  upstreamApiError,
  upstreamApiErrorShown,
  upstreamDisconnectCount,
  upstreamOutageJoinAllowed,
  upstreamOutageOfRun,
  upstreamOutages,
} from "../upstream-outage.js";
import type { CommandState } from "./core.js";
import { apply, fixture, id, ports, value } from "./test-fixtures.js";
import { recordUpstreamHealth } from "./upstream-health.js";
import {
  recordUpstreamOutageResume,
  recordUpstreamOutageSession,
  remindUpstreamOutage,
  resolveUpstreamOutage,
} from "./upstream-outage.js";

describe("upstreamApiErrorShown (C-821)", () => {
  test.each([
    [
      "relay without accounts",
      [
        "● 我先读取卡片。",
        "⎿  API Error: 503 No available accounts: no available accounts · Resend your message to try again",
      ],
    ],
    [
      "wrapped JSON body",
      [
        '⎿  API Error: 503 {"error":{"type":"overloaded_error",',
        '"message":"No available accounts"}}',
      ],
    ],
    ["overloaded 529", ["⎿  API Error: 529 Overloaded"]],
    ["bad gateway", ["⎿  API Error: 502 Bad Gateway"]],
    ["rate limited", ["⎿  API Error: 429 Too Many Requests"]],
    [
      "codex retry exhausted",
      [
        "■ stream error: exceeded retry limit, last status: 503 Service Unavailable",
      ],
    ],
    ["styled", ["\u001b[31m⎿  API Error: 500 Internal Server Error\u001b[0m"]],
  ])("matches %s", (_name, lines) => {
    expect(upstreamApiErrorShown(lines)).toBe(true);
  });
  test.each([
    ["authentication", ["⎿  API Error: 401 Invalid bearer token"]],
    ["bad request", ["⎿  API Error: 400 prompt is too long"]],
    ["disconnect", ["⎿  API Error: Connection lost mid-response"]],
    [
      "later output",
      ["⎿  API Error: 503 No available accounts", "● 已恢复，继续处理。"],
    ],
    ["prose", ["● 上次遇到 No available accounts 报错，已经恢复。"]],
    ["nothing", []],
  ])("ignores %s", (_name, lines) => {
    expect(upstreamApiErrorShown(lines)).toBe(false);
  });
  test("looks only at the lines right above the editor", () => {
    expect(
      upstreamApiErrorShown([
        "⎿  API Error: 503 No available accounts",
        ...Array.from({ length: 12 }, (_, n) => `line ${n}`),
      ]),
    ).toBe(false);
  });
});

function scenario() {
  const allocator = ports();
  let now = "2026-11-27T07:25:00.000Z";
  const minutes = (m: number) =>
    new Date(Date.parse("2026-11-27T07:25:00.000Z") + m * 60_000).toISOString();
  const employee = { id: "E-13", name: "关羽" } as unknown as Employee;
  const base = fixture();
  let state: CommandState = {
    ...base,
    employees: [employee],
    assignments: base.assignments.map((a) =>
      a.id === id("assignment", 1) ? { ...a, employee_id: "E-13" } : a,
    ) as CommandState["assignments"],
  };
  const actor = { kind: "system" as const, project_id: state.project_id };
  const p = () => ({ ...allocator, clock: { now: () => now } });
  const run = <T>(effect: { ok: true; value: T } | { ok: false }) => {
    const result = value(effect as never) as never;
    state = apply(state, result);
    return result as T;
  };
  const join = (
    n: number,
    provider = "relay",
    error?: "outage" | "disconnect",
    disconnect_limit?: number,
  ) =>
    run(
      recordUpstreamOutageSession(
        state,
        actor,
        {
          provider,
          assignment_id: id("assignment", n),
          run_id: id("run", n),
          profile: "claude-opus-high",
          ...(error ? { error } : {}),
          ...(disconnect_limit !== undefined ? { disconnect_limit } : {}),
        },
        p(),
      ),
    ) as { data: { outage_id?: string; started: boolean } };
  return {
    get state() {
      return state;
    },
    set now(at: string) {
      now = at;
    },
    minutes,
    actor,
    p,
    run,
    join,
  };
}

describe("upstream outage commands (C-821)", () => {
  test("sessions of one provider merge into one outage without alerts or handoff", () => {
    const s = scenario();
    expect(s.join(1).data.started).toBe(true);
    s.now = s.minutes(2);
    expect(s.join(2).data.started).toBe(false);
    s.now = s.minutes(3);
    // The same Run never joins twice.
    expect(s.join(2).data.outage_id).toBeUndefined();
    const types = s.state.events.map((e) => e.type);
    expect(types.filter((t) => t === "upstream_outage_started")).toHaveLength(
      1,
    );
    expect(
      types.filter((t) => t === "upstream_outage_session_added"),
    ).toHaveLength(2);
    expect(types).not.toContain("human_action_requested");
    expect(s.state.human_actions).toEqual([]);
    const [outage] = upstreamOutages(s.state);
    expect(outage?.provider).toBe("relay");
    expect(outage?.sessions.map((x) => x.run_id)).toEqual([
      id("run", 1),
      id("run", 2),
    ]);
    // A card timeline entry records the stop; it is not a notification.
    expect(s.state.timeline.map((t) => t.card_id)).toEqual([
      id("card", 1),
      id("card", 1),
    ]);
  });

  test("another provider opens its own outage", () => {
    const s = scenario();
    s.join(1, "relay");
    expect(s.join(2, "official").data.started).toBe(true);
    expect(upstreamOutages(s.state).map((o) => o.provider)).toEqual([
      "relay",
      "official",
    ]);
  });

  test("a stopped Run is held until its one resume attempt", () => {
    const s = scenario();
    const outage = s.join(1).data.outage_id as string;
    expect(runHeldByUpstreamOutage(s.state, id("run", 1), s.minutes(5))).toBe(
      true,
    );
    expect(() =>
      value(
        recordUpstreamOutageResume(
          s.state,
          s.actor,
          { outage_id: outage, run_id: id("run", 1), result: "sent" },
          s.p(),
        ),
      ),
    ).toThrow(/after the outage resolved/);
    s.now = s.minutes(20);
    s.run(
      resolveUpstreamOutage(
        s.state,
        s.actor,
        { outage_id: outage, evidence: "model_probe" },
        s.p(),
      ),
    );
    expect(runHeldByUpstreamOutage(s.state, id("run", 1), s.minutes(21))).toBe(
      true,
    );
    // Past the resume window the existing inactivity flow applies again.
    expect(runHeldByUpstreamOutage(s.state, id("run", 1), s.minutes(31))).toBe(
      false,
    );
    s.run(
      recordUpstreamOutageResume(
        s.state,
        s.actor,
        { outage_id: outage, run_id: id("run", 1), result: "sent" },
        s.p(),
      ),
    );
    // A resumed Run keeps one window to show progress, then the normal flow applies.
    expect(runHeldByUpstreamOutage(s.state, id("run", 1), s.minutes(21))).toBe(
      true,
    );
    expect(runHeldByUpstreamOutage(s.state, id("run", 1), s.minutes(31))).toBe(
      false,
    );
    expect(
      runAwaitingUpstreamResume(s.state, id("run", 1), s.minutes(21)),
    ).toBe(false);
    expect(() =>
      value(
        recordUpstreamOutageResume(
          s.state,
          s.actor,
          { outage_id: outage, run_id: id("run", 1), result: "sent" },
          s.p(),
        ),
      ),
    ).toThrow(/already has a resume/);
    s.run(
      recordUpstreamOutageResume(
        s.state,
        s.actor,
        { outage_id: outage, run_id: id("run", 1), result: "unconfirmed" },
        s.p(),
      ),
    );
    expect(
      upstreamOutageOfRun(s.state, id("run", 1))?.sessions[0]?.resume?.result,
    ).toBe("unconfirmed");
    const entry = s.state.timeline.find((t) =>
      t.body.startsWith("已给 A-1 发接续消息"),
    );
    expect(entry?.body).toContain("07:25Z 到 07:45Z");
  });

  test("a long outage reminds Needs You once and the reminder is withdrawn on recovery", () => {
    const s = scenario();
    const outage = s.join(1).data.outage_id as string;
    s.join(2);
    s.now = s.minutes(31);
    s.run(
      remindUpstreamOutage(
        s.state,
        s.actor,
        {
          outage_id: outage,
          alternatives: ["claude-official", "codex-high", "claude-official"],
        },
        s.p(),
      ),
    );
    expect(() =>
      value(
        remindUpstreamOutage(
          s.state,
          s.actor,
          { outage_id: outage, alternatives: [] },
          s.p(),
        ),
      ),
    ).toThrow(/already resolved or reminded/);
    const [action] = s.state.human_actions;
    expect(action?.status).toBe("open");
    expect(action?.triage).toBe("human");
    expect(action?.instructions).toContain("关羽（A-1）");
    expect(action?.instructions).toContain("A-2");
    expect(action?.instructions).toContain("claude-official、codex-high");
    expect(action?.instructions).toContain("超过 31 分钟");
    s.now = s.minutes(40);
    s.run(
      resolveUpstreamOutage(
        s.state,
        s.actor,
        { outage_id: outage, evidence: "model_probe" },
        s.p(),
      ),
    );
    expect(s.state.human_actions[0]?.status).toBe("cancelled");
    expect(() =>
      value(
        resolveUpstreamOutage(
          s.state,
          s.actor,
          { outage_id: outage, evidence: "model_probe" },
          s.p(),
        ),
      ),
    ).toThrow(/already resolved/);
  });

  test("only a running Run of an active Assignment can join", () => {
    const s = scenario();
    const ended: CommandState = {
      ...s.state,
      runs: s.state.runs.map((r) =>
        r.id === id("run", 1) ? { ...r, status: "completed" } : r,
      ),
    };
    expect(
      recordUpstreamOutageSession(
        ended,
        s.actor,
        {
          provider: "relay",
          assignment_id: id("assignment", 1),
          run_id: id("run", 1),
        },
        s.p(),
      ).ok,
    ).toBe(false);
    expect(
      recordUpstreamOutageSession(
        s.state,
        s.actor,
        {
          provider: "Bad Provider",
          assignment_id: id("assignment", 1),
          run_id: id("run", 1),
        },
        s.p(),
      ).ok,
    ).toBe(false);
  });

  test("the line diagnosis waits for the outage instead of restarting or handing off", () => {
    const s = scenario();
    s.join(1);
    const targets: UpstreamTarget[] = [1, 2, 3].map((n) => ({
      assignment_id: id("assignment", n),
      provider: "relay",
      group: "relay",
    }));
    const diagnosis = diagnoseUpstream(
      s.state,
      targets[0] as UpstreamTarget,
      targets,
      [],
      DEFAULT_UPSTREAM_POLICY,
      s.minutes(5),
    );
    expect(diagnosis).toMatchObject({
      cause: "upstream_outage",
      action: "wait",
    });
    // A failed connection probe would open a line incident with a human
    // action; a session already in an outage does not count toward it.
    const health = (state: CommandState) =>
      recordUpstreamHealth(
        { ...state, runs: state.runs.filter((r) => r.id === id("run", 1)) },
        s.actor,
        {
          targets,
          probes: [
            {
              provider: "relay",
              group: "relay",
              status: "unreachable",
              checked_at: s.minutes(5),
              last_failure_at: s.minutes(5),
              failure: "connection_error",
            },
          ],
          activity: {},
          policy: DEFAULT_UPSTREAM_POLICY,
        },
        s.p(),
      );
    const without = value(health({ ...s.state, events: [], timeline: [] }));
    expect(without.events.map((e) => e.type)).toContain(
      "upstream_incident_started",
    );
    const effect = value(health(s.state));
    expect(effect.events.map((e) => e.type)).not.toContain(
      "upstream_incident_started",
    );
    expect(effect.events.map((e) => e.type)).not.toContain(
      "human_action_requested",
    );
  });
});

describe("upstreamApiError (C-842)", () => {
  test.each([
    [
      "claude connection lost",
      [
        "● 正在写设计稿。",
        "⎿  API Error: Connection lost mid-response. The response above may be incomplete.",
      ],
    ],
    [
      "codex stream disconnected",
      ["■ stream disconnected before completion: error sending request"],
    ],
    [
      "disconnect after an earlier outage",
      [
        "⎿  API Error: 503 No available accounts",
        "⎿  API Error: Connection lost mid-response",
      ],
    ],
  ])("classifies %s as a disconnect", (_name, lines) => {
    expect(upstreamApiError(lines)).toBe("disconnect");
    expect(upstreamApiErrorShown(lines)).toBe(false);
  });
  test.each([
    ["outage", ["⎿  API Error: 503 No available accounts"], "outage"],
    ["authentication", ["⎿  API Error: 401 Invalid bearer token"], undefined],
    [
      "later output",
      ["⎿  API Error: Connection lost mid-response", "● 继续处理。"],
      undefined,
    ],
    ["prose", ["● 上次 stream disconnected 了，已经恢复。"], undefined],
  ])("classifies %s", (_name, lines, expected) => {
    expect(upstreamApiError(lines)).toBe(expected);
  });
  test("the policy fills unset values from the defaults", () => {
    expect(resolveUpstreamOutagePolicy({ disconnect_resume_limit: 3 })).toEqual(
      {
        probe_interval_ms: 60_000,
        remind_after_ms: 30 * 60_000,
        resume_window_ms: 10 * 60_000,
        disconnect_resume_limit: 3,
      },
    );
  });
});

describe("dropped connections join the outage flow (C-842)", () => {
  const resolveAndResume = (
    s: ReturnType<typeof scenario>,
    outage: string,
    run: number,
    at: number,
  ) => {
    s.now = s.minutes(at);
    s.run(
      resolveUpstreamOutage(
        s.state,
        s.actor,
        { outage_id: outage, evidence: "model_probe" },
        s.p(),
      ),
    );
    s.run(
      recordUpstreamOutageResume(
        s.state,
        s.actor,
        { outage_id: outage, run_id: id("run", run), result: "sent" },
        s.p(),
      ),
    );
  };

  test("a disconnect opens its own outage record and gets one resume per stop, up to the limit", () => {
    const s = scenario();
    const first = s.join(1, "relay", "disconnect").data.outage_id as string;
    expect(first).toBeDefined();
    const [outage] = upstreamOutages(s.state);
    expect(outage?.cause).toBe("disconnect");
    expect(outage?.sessions[0]?.error).toBe("disconnect");
    // Still waiting for its resume: it cannot join again.
    expect(upstreamOutageJoinAllowed(s.state, id("run", 1), "disconnect")).toBe(
      false,
    );
    s.now = s.minutes(1);
    expect(s.join(1, "relay", "disconnect").data.outage_id).toBeUndefined();
    resolveAndResume(s, first, 1, 2);
    const resolved = s.state.events.findLast(
      (e) => e.type === "upstream_outage_resolved",
    );
    expect(
      (resolved?.payload as { body?: string } | undefined)?.body,
    ).toContain("连接中断后停住的 1 个会话");
    const sent = s.state.timeline.findLast((t) =>
      t.body.startsWith("已给 A-1 发接续消息"),
    );
    expect(sent?.body).toContain("连接中断后停住");
    // A second disconnect of the same Run joins a new outage record.
    s.now = s.minutes(20);
    const second = s.join(1, "relay", "disconnect").data.outage_id as string;
    expect(second).toBeDefined();
    expect(second).not.toBe(first);
    expect(upstreamDisconnectCount(s.state, id("run", 1))).toBe(2);
    expect(
      s.state.timeline.findLast((t) => t.body.includes("本轮第 2 次"))?.body,
    ).toContain("最多自动接续 2 次");
    expect(
      runAwaitingUpstreamResume(s.state, id("run", 1), s.minutes(21)),
    ).toBe(true);
    resolveAndResume(s, second, 1, 22);
    // The limit (default 2) is used up: no third record, the inactivity flow applies.
    s.now = s.minutes(40);
    expect(upstreamOutageJoinAllowed(s.state, id("run", 1), "disconnect")).toBe(
      false,
    );
    expect(s.join(1, "relay", "disconnect").data.outage_id).toBeUndefined();
    expect(runHeldByUpstreamOutage(s.state, id("run", 1), s.minutes(40))).toBe(
      false,
    );
    expect(
      s.state.events.filter((e) => e.type === "upstream_outage_session_added"),
    ).toHaveLength(2);
    expect(s.state.human_actions).toEqual([]);
  });

  test("the limit is configurable; zero turns disconnect resumes off", () => {
    const s = scenario();
    expect(s.join(1, "relay", "disconnect", 0).data.outage_id).toBeUndefined();
    const first = s.join(2, "relay", "disconnect", 1).data.outage_id as string;
    resolveAndResume(s, first, 2, 2);
    s.now = s.minutes(5);
    expect(s.join(2, "relay", "disconnect", 1).data.outage_id).toBeUndefined();
    expect(() =>
      value(
        recordUpstreamOutageSession(
          s.state,
          s.actor,
          {
            provider: "relay",
            assignment_id: id("assignment", 3),
            run_id: id("run", 3),
            error: "disconnect",
            disconnect_limit: -1,
          },
          s.p(),
        ),
      ),
    ).toThrow(/Invalid disconnect limit/);
  });

  test("an outage stop stays once per Run, also after a disconnect", () => {
    const s = scenario();
    const outage = s.join(1).data.outage_id as string;
    resolveAndResume(s, outage, 1, 2);
    s.now = s.minutes(20);
    // C-821 unchanged: a Run that stopped on an outage never joins again.
    expect(s.join(1).data.outage_id).toBeUndefined();
    expect(s.join(1, "relay", "disconnect").data.outage_id).toBeUndefined();
    const t = scenario();
    const dropped = t.join(1, "relay", "disconnect").data.outage_id as string;
    resolveAndResume(t, dropped, 1, 2);
    t.now = t.minutes(20);
    expect(t.join(1).data.outage_id).toBeDefined();
    t.now = t.minutes(21);
    expect(t.join(1, "relay", "disconnect").data.outage_id).toBeUndefined();
  });

  test("a disconnect during an open outage of its provider joins that outage", () => {
    const s = scenario();
    const outage = s.join(1).data.outage_id as string;
    s.now = s.minutes(1);
    const joined = s.join(2, "relay", "disconnect");
    expect(joined.data).toEqual({ outage_id: outage, started: false });
    const [o] = upstreamOutages(s.state);
    expect(o?.cause).toBeUndefined();
    expect(o?.sessions.map((x) => x.error)).toEqual([undefined, "disconnect"]);
    s.now = s.minutes(3);
    s.run(
      resolveUpstreamOutage(
        s.state,
        s.actor,
        { outage_id: outage, evidence: "model_probe" },
        s.p(),
      ),
    );
    const resolved = s.state.events.findLast(
      (e) => e.type === "upstream_outage_resolved",
    );
    expect(
      (resolved?.payload as { body?: string } | undefined)?.body,
    ).toContain("中断约");
  });
});
