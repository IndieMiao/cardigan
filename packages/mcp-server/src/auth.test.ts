/**
 * M4.4 token hardening (plan §4 M4.4, development plan §12.6).
 *
 * Revoking the token on release is the first line of defence; authentication
 * also refuses any Assignment that is not `active`, so a suspended Assignment
 * cannot read cards through a token that has not been rotated yet.
 */
import { Store } from "@cardigan/store";
import { afterEach, beforeEach, expect, test } from "vitest";
import { authenticate } from "./auth.js";
import { project_id, seedProject } from "./test-support.js";

let store: Store;
let token: string;

beforeEach(() => {
  store = Store.open({ dbPath: ":memory:" });
  const seeded = seedProject(store, {
    allowed_tools: ["whoami", "get_card", "submit_delivery"],
  });
  token = store.issueToken({
    project_id,
    assignment_id: seeded.assignment.id,
    role: { role_version: 1, allowed_tools: ["whoami", "get_card"] },
  }).token;
});
afterEach(() => store.close());

const setStatus = (status: "active" | "suspended" | "released") =>
  store.uow.run((tx) => {
    const assignment = tx.assignments.get(project_id, "A-1" as never);
    if (assignment === undefined) throw new Error("missing assignment");
    tx.assignments.put(project_id, { ...assignment, status });
  });

test("an active assignment authenticates", () => {
  const identity = authenticate(store, token);
  expect(identity.ok).toBe(true);
  if (!identity.ok) return;
  expect(identity.value.assignment.status).toBe("active");
  expect(identity.value.actor.assignment_id).toBe("A-1");
});

test.each(["suspended", "released"] as const)(
  "a %s assignment is rejected even with a live token",
  (status) => {
    setStatus(status);
    const identity = authenticate(store, token);
    expect(identity.ok).toBe(false);
    if (identity.ok) return;
    expect(identity.error.code).toBe("unauthorized");
  },
);

test("a revoked token is rejected before the assignment is consulted", () => {
  expect(store.revokeToken("tok_missing")).toBe(false);
  const issued = store.issueToken({
    id: "tok-revoke",
    project_id,
    assignment_id: "A-1" as never,
    role: { role_version: 1, allowed_tools: ["whoami"] },
  });
  store.revokeToken(issued.record.id);
  expect(authenticate(store, issued.token).ok).toBe(false);
});
