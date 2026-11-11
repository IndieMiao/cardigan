/**
 * M4.5 contract: the standing PM mode is data (development plan §4, §7.1, §10.4;
 * M4 plan §4 M4.5).
 *
 * PM Office and PM Ops share the `pm` role. Their only durable difference is
 * `standing_mode`; the token scope is derived from it, and the mode is written
 * once. These tests pin the pure rules the store, the host and the resolver use.
 */

import { expect, expectTypeOf, test } from "vitest";
import type { Assignment, ToolName } from "./entities.js";
import {
  applyStandingMode,
  standingModeFromTools,
  standingModeOf,
  standingTools,
} from "./standing.js";

const pmTools: readonly ToolName[] = [
  "whoami",
  "create_card",
  "record_decision",
];

const standing = (overrides: Partial<Assignment> = {}): Assignment =>
  ({
    id: "A-1" as never,
    scope: "standing",
    role_id: "pm",
    role_version: 1,
    status: "active",
    runtime_state: "not_provisioned",
    machine_id: "local",
    runtime_ref: null,
    mcp_token_id: "pm-office",
    created_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  }) as Assignment;

test("office keeps the pm tools, ops loses record_decision", () => {
  expect(standingTools(pmTools, "office")).toEqual(pmTools);
  expect(standingTools(pmTools, "ops")).toEqual(["whoami", "create_card"]);
  // A role without the tool cannot be promoted into an office by scope alone.
  expect(standingTools(["whoami"], "office")).toEqual(["whoami"]);
});

test("the legacy inference reads record_decision from a token scope", () => {
  expect(standingModeFromTools(pmTools)).toBe("office");
  expect(standingModeFromTools(["whoami"])).toBe("ops");
  expect(standingModeFromTools([])).toBe("ops");
});

test("release_assignment belongs to Ops only and is never added to older roles", () => {
  const tools: readonly ToolName[] = [...pmTools, "release_assignment"];
  expect(standingTools(tools, "office")).not.toContain("release_assignment");
  expect(standingTools(tools, "ops")).toContain("release_assignment");
  expect(standingTools(pmTools, "ops")).not.toContain("release_assignment");
});

test("applying a mode stamps a standing pm Assignment", () => {
  const office = applyStandingMode(standing(), "office");
  expect(office.ok).toBe(true);
  expect(office.ok && office.value.standing_mode).toBe("office");
  expect(standingModeOf(office.ok ? office.value : standing())).toBe("office");
});

test("applying the same mode again is a no-op success", () => {
  const stamped = standing({ standing_mode: "ops" });
  expect(applyStandingMode(stamped, "ops")).toEqual({
    ok: true,
    value: stamped,
  });
});

test.each([
  ["office", "ops"],
  ["ops", "office"],
] as const)("a standing Assignment cannot change %s to %s", (from, to) => {
  const result = applyStandingMode(standing({ standing_mode: from }), to);
  expect(result.ok).toBe(false);
  expect(result.ok ? "" : result.error.code).toBe("validation_failed");
  expect(result.ok ? "" : result.error.message).toContain(
    "cannot change its mode",
  );
});

test("work-item Assignments and non-pm roles have no mode", () => {
  const item = {
    ...standing(),
    scope: "work_item",
    work_item_id: "W-1",
  } as Assignment;
  expect(applyStandingMode(item, "office").ok).toBe(false);
  expect(standingModeOf(item)).toBeUndefined();

  const coder = standing({ role_id: "coder" } as Partial<Assignment>);
  expect(applyStandingMode(coder, "ops").ok).toBe(false);
});

test("the field is written once: re-reading it never re-infers", () => {
  const stamped = standing({ standing_mode: "ops" });
  expect(standingModeOf(stamped)).toBe("ops");
  // A different token scope cannot move it any more.
  expect(applyStandingMode(stamped, "office").ok).toBe(false);
  expectTypeOf(stamped.standing_mode).toEqualTypeOf<
    "office" | "ops" | undefined
  >();
});

test("C-110: verifier replacement is issued only to standing PM Ops", () => {
  const tools = ["whoami", "replace_verification_work_item"] as const;
  expect(standingTools(tools, "office")).toEqual(["whoami"]);
  expect(standingTools(tools, "ops")).toEqual(tools);
});
