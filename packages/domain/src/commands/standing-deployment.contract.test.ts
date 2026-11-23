import { expect, test } from "vitest";
import type { Actor, Assignment, Event } from "../entities.js";
import { rotateStandingAfterDeployment } from "./standing-deployment.js";
import { fixture, human, id, now, ports, role } from "./test-fixtures.js";

const system: Actor = { kind: "system", project_id: human.project_id };

function standing(version: number, upgradedTo: readonly number[]) {
  const base = fixture();
  const session: Assignment = {
    id: id("assignment", 9),
    scope: "standing",
    role_id: "tester",
    role_version: version,
    status: "active",
    runtime_state: "idle",
    machine_id: "local",
    runtime_ref: null,
    mcp_token_id: "token-reference-9",
    created_at: now,
  };
  const events: Event[] = upgradedTo.map((to, i) => ({
    id: `${"0".repeat(24)}${i + 10}` as never,
    seq: i + 1,
    type: "host_role_upgraded",
    actor: system,
    payload: { role_id: "tester", from_version: to - 1, to_version: to },
    created_at: now,
  }));
  return {
    ...base,
    roles: [
      ...base.roles,
      ...[1, 2, 3].map((v) => ({ ...role("tester"), role_version: v })),
    ],
    assignments: [...base.assignments, session],
    events,
  };
}

test("C-613 a session pinned before an audited upgrade rotates to a later metadata-only version", () => {
  const result = rotateStandingAfterDeployment(
    standing(1, [2]),
    system,
    id("assignment", 9),
    ports(),
  );
  expect(result.ok).toBe(true);
  if (result.ok) expect(result.value.data.assignment.role_version).toBe(3);
});

test("C-613 a session already on the audited version does not rotate for metadata alone", () => {
  const result = rotateStandingAfterDeployment(
    standing(2, [2]),
    system,
    id("assignment", 9),
    ports(),
  );
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error.message).toContain("升级审计");
});
