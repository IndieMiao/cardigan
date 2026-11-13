import { beforeEach, expect, test } from "vitest";
import type { Actor, Assignment, Event, RuntimeRef } from "../index.js";
import {
  acknowledgeRun,
  DEFAULT_RUNTIME_UNKNOWN_GRACE_MS,
  listNeedsYou,
  MAX_RUNTIME_FAILURE_LIMIT,
  MIN_RUNTIME_FAILURE_LIMIT,
  parseRuntimeUnknownGraceMs,
  runtimeUnknownVisibleAt,
} from "../index.js";
import {
  actor,
  commit,
  dispatch,
  f,
  item,
  present,
  queue,
  setup,
  system,
} from "./launch/test-fixtures.js";
import { human, role, value } from "./test-fixtures.js";

const T0 = Date.parse("2026-01-01T01:00:00.000Z");
const at = (ms: number) => new Date(T0 + ms).toISOString();
const clock = (ms: number) => ({ now: () => at(ms) });

beforeEach(() => {
  setup();
  const sent = commit(dispatch(commit(queue())));
  commit(acknowledgeRun(f.state, actor(), { run_id: sent.id }, f.io));
});

/** Model the RuntimeMonitor's persisted facts; observations are host IO. */
function runtime(
  state: "unknown" | "idle" | "lost",
  facts: readonly (readonly [type: string, ms: number, cause?: string])[],
  runtime_ref = coder().runtime_ref,
) {
  const runtime_key = JSON.stringify(runtime_ref);
  f.state = {
    ...f.state,
    assignments: f.state.assignments.map((a) =>
      a.id === f.coder.id ? { ...a, runtime_state: state, runtime_ref } : a,
    ),
    events: [
      ...f.state.events,
      ...facts.map(
        ([type, ms, cause]): Event => ({
          id: f.io.ids.nextEventId(),
          seq: f.io.ids.nextEventSequence(f.state.project_id, item().card_id),
          card_id: item().card_id,
          type,
          actor: system,
          created_at: at(ms),
          payload: {
            assignment_id: f.coder.id,
            runtime_key,
            ...(cause ? { cause } : {}),
          },
        }),
      ),
    ],
  };
}
const humanIncidents = (ms: number, runtimeUnknownGraceMs?: number) =>
  value(
    listNeedsYou(
      f.state,
      human,
      clock(ms),
      runtimeUnknownGraceMs === undefined ? {} : { runtimeUnknownGraceMs },
    ),
  ).data.incidents.map((i) => i.id);
function coder() {
  return present(f.state.assignments.find((a) => a.id === f.coder.id));
}

test("C-228 Q-387 fixes the defaults at 60 s grace and a 2..10 failure limit", () => {
  expect(DEFAULT_RUNTIME_UNKNOWN_GRACE_MS).toBe(60_000);
  expect([MIN_RUNTIME_FAILURE_LIMIT, MAX_RUNTIME_FAILURE_LIMIT]).toEqual([
    2, 10,
  ]);
});

test("C-228 a failures-only unknown stays out of the human queue for the grace period", () => {
  runtime("unknown", [["runtime_disconnected", 0, "failures"]]);
  expect(humanIncidents(0)).toEqual([]);
  expect(humanIncidents(59_999)).toEqual([]);
  expect(humanIncidents(60_000)).toEqual([f.coder.id]);
  expect(runtimeUnknownVisibleAt(f.state.events, coder(), 60_000)).toBe(
    at(60_000),
  );
  // Configurable: a shorter host setting surfaces it sooner.
  expect(humanIncidents(30_000, 30_000)).toEqual([f.coder.id]);
});

test("C-228 reconnecting within the grace period never reaches the human", () => {
  runtime("idle", [
    ["runtime_disconnected", 0, "failures"],
    ["runtime_reconnected", 20_000],
  ]);
  for (const ms of [0, 20_000, 60_000, 600_000])
    expect(humanIncidents(ms)).toEqual([]);
});

test.each([
  ["explicit exit", [["runtime_disconnected", 0, "exit"]]],
  ["legacy fact without a cause", [["runtime_disconnected", 0]]],
  [
    "explicit exit after a failures-only unknown",
    [
      ["runtime_disconnected", 0, "failures"],
      ["runtime_exit_observed", 5_000],
    ],
  ],
] as const)("C-228 %s is shown immediately", (_, facts) => {
  runtime("unknown", facts);
  expect(humanIncidents(5_000)).toEqual([f.coder.id]);
  expect(runtimeUnknownVisibleAt(f.state.events, coder(), 60_000)).toBeNull();
});

test("C-228 lost is shown immediately even after a failures-only disconnect", () => {
  runtime("lost", [
    ["runtime_disconnected", 0, "failures"],
    ["runtime_lost", 300_000],
  ]);
  expect(humanIncidents(300_000)).toEqual([f.coder.id]);
});

test("C-228 repeated short reconnects cannot postpone the incident forever", () => {
  // Disconnected at 0, back at 20 s, failing again at 30 s: one flapping run.
  runtime("unknown", [
    ["runtime_disconnected", 0, "failures"],
    ["runtime_reconnected", 20_000],
    ["runtime_disconnected", 30_000, "failures"],
  ]);
  expect(humanIncidents(59_999)).toEqual([]);
  expect(humanIncidents(60_000)).toEqual([f.coder.id]);
});

test("C-228 a reconnect older than the grace period starts a new run", () => {
  runtime("unknown", [
    ["runtime_disconnected", 0, "failures"],
    ["runtime_reconnected", 10_000],
    ["runtime_disconnected", 70_000, "failures"],
  ]);
  expect(humanIncidents(129_999)).toEqual([]);
  expect(humanIncidents(130_000)).toEqual([f.coder.id]);
});

test("C-228 PM views keep every incident; only the human queue waits", () => {
  const { work_item_id: _work, ...fields } = f.reviewer;
  const pm: Assignment = {
    ...fields,
    id: "A-99" as Assignment["id"],
    role_id: "pm",
    scope: "standing",
    standing_mode: "office",
  };
  f.state = { ...f.state, assignments: [...f.state.assignments, pm] };
  const pmActor: Actor = {
    kind: "assignment",
    project_id: f.state.project_id,
    assignment_id: pm.id,
    ...role("pm"),
    role_version: pm.role_version,
    allowed_tools: ["list_needs_you"],
  };
  runtime("unknown", [["runtime_disconnected", 0, "failures"]]);
  expect(
    value(listNeedsYou(f.state, pmActor, clock(0))).data.incidents.map(
      (i) => i.id,
    ),
  ).toEqual([f.coder.id]);
  expect(humanIncidents(0)).toEqual([]);
});

test("C-228 grace setting must be a positive integer below the loss grace period", () => {
  expect(parseRuntimeUnknownGraceMs(undefined)).toBe(60_000);
  expect(parseRuntimeUnknownGraceMs(" ")).toBe(60_000);
  expect(parseRuntimeUnknownGraceMs("30")).toBe(30_000);
  expect(parseRuntimeUnknownGraceMs("299")).toBe(299_000);
  for (const text of ["0", "-1", "1.5", "60s", "NaN", "Infinity", "300", "1e3"])
    expect(() => parseRuntimeUnknownGraceMs(text)).toThrow(
      "CARDIGAN_RUNTIME_UNKNOWN_GRACE_SECONDS",
    );
});

test("C-228 V-804 a replacement Session does not inherit the old terminal's grace", () => {
  const old: RuntimeRef = { ...present(coder().runtime_ref ?? undefined) };
  // Old terminal: failures-only disconnect, recovered 55 s later.
  runtime(
    "idle",
    [
      ["runtime_disconnected", 0, "failures"],
      ["runtime_reconnected", 55_000],
    ],
    old,
  );
  // Session replaced at 60 s; the new terminal first fails at 80 s.
  runtime("unknown", [["runtime_disconnected", 80_000, "failures"]], {
    ...old,
    terminal_ref: "t2",
    agent_session_id: "session-2",
  });
  expect(runtimeUnknownVisibleAt(f.state.events, coder(), 60_000)).toBe(
    at(140_000),
  );
  expect(humanIncidents(80_000)).toEqual([]);
  expect(humanIncidents(139_999)).toEqual([]);
  expect(humanIncidents(140_000)).toEqual([f.coder.id]);
});

test("C-228 an explicit exit seen on an old Session does not surface the new one", () => {
  const old: RuntimeRef = { ...present(coder().runtime_ref ?? undefined) };
  runtime(
    "idle",
    [
      ["runtime_disconnected", 0, "failures"],
      ["runtime_exit_observed", 1_000],
    ],
    old,
  );
  runtime("unknown", [["runtime_disconnected", 80_000, "failures"]], {
    ...old,
    terminal_ref: "t2",
  });
  expect(humanIncidents(80_000)).toEqual([]);
});
