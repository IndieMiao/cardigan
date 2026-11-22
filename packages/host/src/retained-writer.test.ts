import type { CommandState, Event } from "@cardigan/domain";
import { expect, test } from "vitest";
import { firstIncidentBackup, incidentIdentity } from "./retained-writer.js";

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

test("the incident's first system backup is the identity; later or foreign records never replace it", () => {
  const first = event("host_ops_action_taken", incident);
  const takeover = event("host_ops_action_taken", incident, ops);
  const other = event("host_ops_action_taken", {
    ...incident,
    system_finished_run_id: "R-7",
  });
  const events = [
    first,
    event("dispatch_stall_backup_verified", {
      action_id: first.id,
      assignment_id: "A-1",
      sha: "a".repeat(40),
      workspace_seal: "original",
    }),
    other,
    event("dispatch_stall_backup_verified", {
      action_id: other.id,
      assignment_id: "A-1",
      sha: "b".repeat(40),
      workspace_seal: "other-incident",
    }),
    takeover,
    event("dispatch_stall_backup_verified", {
      action_id: takeover.id,
      assignment_id: "A-1",
      sha: "a".repeat(40),
      workspace_seal: "replacement",
    }),
  ];
  // Looked up by incident, not by the newer action that is asking.
  expect(firstIncidentBackup(state(events), incident)?.workspace_seal).toBe(
    "original",
  );
  expect(incidentIdentity(state(events), incident, "original")).toMatchObject({
    workspace_seal: "original",
  });
  expect(incidentIdentity(state(events), incident, "replacement")).toBeNull();
  // A record not written by the system is not identity evidence.
  const forged = [
    first,
    event(
      "dispatch_stall_backup_verified",
      { action_id: first.id, assignment_id: "A-1", workspace_seal: "forged" },
      ops,
    ),
  ];
  expect(firstIncidentBackup(state(forged), incident)).toBeUndefined();
});

test("a refused incident without its first record is refused; a fresh incident records its first", () => {
  const first = event("host_ops_action_taken", incident);
  const refused = event("retained_writer_refused", {
    ...incident,
    action_id: first.id,
    run_id: "R-2",
  });
  // No backup record yet and no refusal: this action records the first.
  expect(incidentIdentity(state([first]), incident, "any")).toBeUndefined();
  // The refusal makes the missing first record mandatory evidence.
  expect(incidentIdentity(state([first, refused]), incident, "any")).toBeNull();
  // A refusal of a different incident does not.
  expect(
    incidentIdentity(
      state([
        first,
        event("retained_writer_refused", {
          ...incident,
          system_finished_run_id: "R-7",
        }),
      ]),
      incident,
      "any",
    ),
  ).toBeUndefined();
});
