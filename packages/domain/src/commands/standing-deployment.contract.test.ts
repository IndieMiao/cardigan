import { expect, test } from "vitest";
import type { Actor, Assignment, Event, RoleReference } from "../entities.js";
import {
  deploymentAuditedVersion,
  rotateStandingAfterDeployment,
} from "./standing-deployment.js";
import { fixture, human, id, now, ports, role } from "./test-fixtures.js";

const system: Actor = { kind: "system", project_id: human.project_id };

type Audit = {
  readonly to: number;
  readonly from?: number;
  readonly metadata_only?: boolean;
  readonly card?: boolean;
  readonly human?: boolean;
};

/** A tester session pinned at `version`; v1..v3 exist, v3 may have another launch profile. */
function standing(
  version: number,
  audits: readonly Audit[],
  v3: Partial<RoleReference> = {},
) {
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
  const events: Event[] = audits.map((a, i) => ({
    id: `${"0".repeat(24)}${i + 10}` as never,
    seq: i + 1,
    type: "host_role_upgraded",
    actor: a.human ? human : system,
    ...(a.card ? { card_id: id("card", 1) } : {}),
    payload: {
      role_id: "tester",
      from_version: a.from ?? a.to - 1,
      to_version: a.to,
      ...(a.metadata_only ? { metadata_only: true } : {}),
    },
    created_at: now,
  }));
  return {
    ...base,
    roles: [
      ...base.roles,
      ...[1, 2, 3].map((v) => ({
        ...role("tester"),
        launch_profile_ref: "fixture",
        role_version: v,
        ...(v === 3 ? v3 : {}),
      })),
    ],
    assignments: [...base.assignments, session],
    events,
  };
}

const rotate = (state: ReturnType<typeof standing>) =>
  rotateStandingAfterDeployment(state, system, id("assignment", 9), ports());

test("C-613 V-3037:1 a session rotates only to a version an audited upgrade reaches", () => {
  const audited = rotate(standing(1, [{ to: 3 }]));
  expect(audited.ok).toBe(true);
  if (audited.ok) expect(audited.value.data.assignment.role_version).toBe(3);
  // v2 was audited, v3 was then written by hand: no audit points at v3.
  const edited = rotate(standing(1, [{ to: 2 }]));
  expect(edited.ok).toBe(false);
  if (!edited.ok) expect(edited.error.message).toContain("升级审计");
  // Only an unattached system audit counts.
  for (const forged of [
    { to: 3, card: true },
    { to: 3, human: true },
  ])
    expect(rotate(standing(1, [forged])).ok).toBe(false);
});

test("C-613 V-3037:1 a metadata-only audit carries an audited version with the same policy and launch fields", () => {
  const carried = rotate(
    standing(1, [{ to: 2 }, { to: 3, from: 2, metadata_only: true }]),
  );
  expect(carried.ok).toBe(true);
  if (carried.ok) expect(carried.value.data.assignment.role_version).toBe(3);
  expect(
    deploymentAuditedVersion(
      standing(1, [{ to: 2 }, { to: 3, from: 2, metadata_only: true }]),
      "tester",
      3,
    ),
  ).toBe(2);
  // Another launch profile, other tools, or an unaudited source: not carried.
  for (const state of [
    standing(1, [{ to: 2 }, { to: 3, from: 2, metadata_only: true }], {
      launch_profile_ref: "other",
    }),
    standing(1, [{ to: 2 }, { to: 3, from: 2, metadata_only: true }], {
      allowed_tools: ["get_card"],
    }),
    standing(1, [{ to: 3, from: 2, metadata_only: true }]),
  ])
    expect(rotate(state).ok).toBe(false);
});

test("C-613 a session already on the audited version does not rotate for metadata alone", () => {
  const result = rotate(
    standing(2, [{ to: 2 }, { to: 3, from: 2, metadata_only: true }]),
  );
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error.message).toContain("升级审计");
});
