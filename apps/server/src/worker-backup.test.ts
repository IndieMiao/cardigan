import type { Assignment, Event } from "@cardigan/domain";
import { expect, test } from "vitest";
import { lastSuccessfulWorkerBackup } from "./worker-backup.js";

const project_id = "backup-fixture";
const assignment = {
  id: "A-1" as Assignment["id"],
  machine_id: "worker-a",
  branch: "agent/C-1/W-1",
};
const success: Event = {
  id: "00000000000000000000000001" as Event["id"],
  seq: 1,
  type: "assignment_branch_backed_up",
  actor: { kind: "system", project_id },
  created_at: "2030-01-01T00:00:00.000Z",
  payload: {
    assignment_id: assignment.id,
    machine_id: assignment.machine_id,
    branch: assignment.branch,
    sha: "a".repeat(40),
    ref: `refs/cardigan/backups/${assignment.machine_id}/${assignment.branch}`,
  },
};
const read = (events: readonly Event[]) =>
  lastSuccessfulWorkerBackup({ project_id, events }, assignment);

test("only a persisted successful backup establishes a recovery source and time", () => {
  expect(read([])).toBeUndefined();
  expect(
    read([{ ...success, type: "assignment_branch_backup_failed" }]),
  ).toBeUndefined();
  expect(read([success])).toEqual({
    sha: "a".repeat(40),
    at: success.created_at,
    branch: assignment.branch,
  });
  const newer = {
    ...success,
    seq: 2,
    created_at: "2030-01-01T00:10:00.000Z",
    payload: { ...(success.payload as object), sha: "b".repeat(64) },
  };
  expect(
    read([
      success,
      newer,
      { ...success, type: "assignment_branch_backup_failed" },
    ]),
  ).toEqual({
    sha: "b".repeat(64),
    at: newer.created_at,
    branch: assignment.branch,
  });
});

test.each([
  { assignment_id: "A-2" },
  { machine_id: "worker-b" },
  { branch: "agent/C-2/W-1" },
  { ref: "refs/cardigan/backups/worker-b/agent/C-1/W-1" },
  { sha: "main" },
  { sha: "a".repeat(39) },
])(
  "backup evidence with a different binding or invalid SHA is not a recovery source: %j",
  (fields) => {
    expect(
      read([
        { ...success, payload: { ...(success.payload as object), ...fields } },
      ]),
    ).toBeUndefined();
  },
);

test("another project, an Agent, a card-stream event or a malformed timestamp cannot supply backup evidence", () => {
  for (const invalid of [
    { ...success, actor: { kind: "system", project_id: "other-project" } },
    { ...success, actor: { kind: "human", project_id } },
    {
      ...success,
      actor: {
        kind: "assignment",
        project_id,
        assignment_id: assignment.id,
        role_id: "coder",
        role_version: 1,
        allowed_tools: [],
        capabilities: [],
      },
    },
    { ...success, card_id: "C-1" },
    { ...success, created_at: "invalid" },
  ] as Event[])
    expect(read([invalid])).toBeUndefined();
  expect(
    lastSuccessfulWorkerBackup(
      { project_id, events: [success] },
      { id: assignment.id, machine_id: assignment.machine_id },
    ),
  ).toBeUndefined();
});
