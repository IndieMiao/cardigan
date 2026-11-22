import type { CommandState, Event } from "@cardigan/domain";
import { expect, test } from "vitest";
import {
  firstIncidentBackup,
  incidentIdentity,
  RetainedWriterRefused,
  retainedWriterForRun,
} from "./retained-writer.js";

const system = { kind: "system", project_id: "p" } as const;
const ops = {
  kind: "assignment",
  project_id: "p",
  assignment_id: "A-9",
  role_id: "host_ops",
} as const;
let n = 0;
const event = (
  type: string,
  payload: Record<string, unknown>,
  actor: Event["actor"] = system,
) =>
  ({
    id: `E-${++n}`,
    seq: n,
    type,
    actor,
    created_at: "2030-01-01T00:00:00.000Z",
    payload,
  }) as unknown as Event;
const state = (events: Event[]) => ({ events }) as unknown as CommandState;
const incident = {
  assignment_id: "A-1",
  system_finished_run_id: "R-1",
  dispatch_stall_id: "cause",
};
const asking = (action: Event) => ({ ...incident, action_id: action.id });
const sha = "a".repeat(40);
const receipt = (action: Event, seal: string) =>
  event("dispatch_stall_backup_verified", {
    action_id: action.id,
    assignment_id: "A-1",
    sha,
    workspace_seal: seal,
  });
const settled = (action: Event) =>
  event("host_ops_action_finished", {
    action_id: action.id,
    assignment_id: "A-1",
    run_id: "R-2",
  });
const withdrawn = (action: Event, backupRecorded?: boolean) =>
  event("host_ops_action_finished", {
    action_id: action.id,
    assignment_id: "A-1",
    result: "withdrawn_stall_changed",
    ...(backupRecorded === undefined
      ? {}
      : { backup_recorded: backupRecorded }),
  });

/** C-573#269: the first action settles, its launch is refused, and an Ops
 * takeover of the same incident records an identical (or other) seal. */
function refusedThenTakeover(seal = "original") {
  const first = event("host_ops_action_taken", incident);
  const firstReceipt = receipt(first, "original");
  const takeover = event("host_ops_action_taken", incident, ops);
  const takeoverReceipt = receipt(takeover, seal);
  const history = [
    first,
    firstReceipt,
    settled(first),
    event("retained_writer_refused", {
      ...incident,
      action_id: first.id,
      run_id: "R-2",
    }),
    takeover,
    takeoverReceipt,
  ];
  return { first, takeover, history, firstReceipt, takeoverReceipt };
}

test("both receipts readable: the first settled action's receipt is the identity", () => {
  const { first, takeover, history } = refusedThenTakeover();
  expect(firstIncidentBackup(state(history), incident)).toMatchObject({
    action_id: first.id,
  });
  expect(
    incidentIdentity(state(history), asking(takeover), "original"),
  ).toMatchObject({ action_id: first.id });
});

test("neither receipt readable: refused", () => {
  const { takeover, history, firstReceipt, takeoverReceipt } =
    refusedThenTakeover();
  const unreadable = history.filter(
    (e) => e !== firstReceipt && e !== takeoverReceipt,
  );
  expect(firstIncidentBackup(state(unreadable), incident)).toBeUndefined();
  expect(
    incidentIdentity(state(unreadable), asking(takeover), "original"),
  ).toBeNull();
});

test("only the first receipt unreadable: a later identical receipt never replaces it", () => {
  const { takeover, history, firstReceipt } = refusedThenTakeover();
  const unreadable = history.filter((e) => e !== firstReceipt);
  expect(firstIncidentBackup(state(unreadable), incident)).toBeUndefined();
  expect(
    incidentIdentity(state(unreadable), asking(takeover), "original"),
  ).toBeNull();
});

test("a different seal with the same SHA is refused against the full history", () => {
  const { takeover, history } = refusedThenTakeover("replacement");
  expect(
    incidentIdentity(state(history), asking(takeover), "replacement"),
  ).toBeNull();
});

test("a receipt written by an unsettled attempt stays the identity", () => {
  // The first attempt recorded its receipt but never settled. An Ops takeover
  // with another seal cannot re-own the incident.
  const first = event("host_ops_action_taken", incident);
  const takeover = event("host_ops_action_taken", incident, ops);
  const history = [first, receipt(first, "original"), takeover];
  expect(
    incidentIdentity(state(history), asking(takeover), "replacement"),
  ).toBeNull();
  expect(
    incidentIdentity(state(history), asking(takeover), "original"),
  ).toMatchObject({ action_id: first.id });
});

test("an earlier receipt that was written but is now unreadable is never replaced", () => {
  // C-573#289: the first attempt wrote its receipt, then withdrew unsettled.
  // That receipt is unreadable; a later receipt cannot become the identity.
  const first = event("host_ops_action_taken", incident);
  const takeover = event("host_ops_action_taken", incident, ops);
  const history = [
    first,
    withdrawn(first, true),
    takeover,
    receipt(takeover, "original"),
  ];
  expect(firstIncidentBackup(state(history), incident)).toBeUndefined();
  expect(
    incidentIdentity(state(history), asking(takeover), "original"),
  ).toBeNull();
  // Nor may the takeover record a fresh first before writing anything.
  expect(
    incidentIdentity(
      state([first, withdrawn(first, true), takeover]),
      asking(takeover),
      "original",
    ),
  ).toBeNull();
  // An attempt that withdrew without saying, or never finished, is unknown.
  for (const prior of [[first, withdrawn(first)], [first]])
    expect(
      incidentIdentity(state([...prior, takeover]), asking(takeover), "x"),
    ).toBeNull();
});

test("no receipt ever written and nothing settled: this action records the first", () => {
  // A backup failure withdrew the first attempt before any receipt.
  const first = event("host_ops_action_taken", incident);
  const takeover = event("host_ops_action_taken", incident, ops);
  const history = [first, withdrawn(first, false), takeover];
  expect(
    incidentIdentity(state(history), asking(takeover), "any"),
  ).toBeUndefined();
  // Once that takeover records and settles, its receipt is the identity.
  const takeoverReceipt = receipt(takeover, "original");
  const done = [...history, takeoverReceipt, settled(takeover)];
  expect(firstIncidentBackup(state(done), incident)).toBe(
    takeoverReceipt.payload,
  );
});

test("lookup is by incident; foreign incidents and non-system receipts do not count", () => {
  const first = event("host_ops_action_taken", incident);
  const other = event("host_ops_action_taken", {
    ...incident,
    system_finished_run_id: "R-7",
  });
  const forged = event(
    "dispatch_stall_backup_verified",
    { action_id: first.id, assignment_id: "A-1", workspace_seal: "forged" },
    ops,
  );
  const history = [first, forged, other, receipt(other, "other")];
  expect(firstIncidentBackup(state(history), incident)).toBeUndefined();
  expect(
    incidentIdentity(state(history), asking(first), "any"),
  ).toBeUndefined();
  // Another incident's refusal does not make this one's receipt mandatory.
  expect(
    incidentIdentity(
      state([
        first,
        event("retained_writer_refused", {
          ...incident,
          system_finished_run_id: "R-7",
        }),
      ]),
      asking(first),
      "any",
    ),
  ).toBeUndefined();
});

test("the launch check refuses when only the first receipt is unreadable", () => {
  const bound = { ...incident, run_id: "R-2" };
  const first = event("host_ops_action_taken", bound);
  const takeover = event("host_ops_action_taken", bound, ops);
  const firstReceipt = receipt(first, "original");
  const full = [
    first,
    firstReceipt,
    settled(first),
    event("retained_writer_refused", {
      ...incident,
      action_id: first.id,
      run_id: "R-2",
    }),
    takeover,
    receipt(takeover, "original"),
    settled(takeover),
  ];
  const run = {
    id: "R-2",
    assignment_id: "A-1",
    status: "queued",
    trigger_event_id: "E-none",
  };
  const a = {
    id: "A-1",
    role_id: "coder",
    role_version: 1,
    status: "active",
    work_item_id: "W-1",
    machine_id: "local",
    runtime_ref: null,
    worktree_path: "/w",
    branch: "b",
    base_sha: sha,
  };
  const call = (events: Event[]) =>
    retainedWriterForRun(
      {
        events,
        roles: [{ role_id: "coder", role_version: 1, worktree: "write" }],
        assignments: [a],
        runs: [run],
      } as unknown as CommandState,
      run as unknown as Parameters<typeof retainedWriterForRun>[1],
      a as unknown as Parameters<typeof retainedWriterForRun>[2],
    );
  // Full history: the bound takeover matches the first receipt.
  expect(call(full)).toMatchObject({ tree: { path: "/w" } });
  // Only the first receipt unreadable: refused, no verifier object.
  expect(() => call(full.filter((e) => e !== firstReceipt))).toThrow(
    RetainedWriterRefused,
  );
});
