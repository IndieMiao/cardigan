/**
 * M4.5: routing reads `standing_mode`, not the newest token (M4 plan §4 M4.5,
 * development plan §7.1). The token is only a fallback for a legacy row that a
 * tick sees before the startup backfill.
 */
import type { Assignment, CommandState, ToolName } from "@cardigan/domain";
import type { Store } from "@cardigan/store";
import { expect, test } from "vitest";
import { standingResolver } from "./assembly.js";

const project = "p-standing" as never;

const assignment = (
  id: string,
  mode: "office" | "ops" | undefined,
): Assignment =>
  ({
    id: id as never,
    scope: "standing",
    role_id: "pm",
    role_version: 1,
    status: "active",
    runtime_state: "not_provisioned",
    machine_id: "local",
    runtime_ref: null,
    mcp_token_id: id,
    created_at: "2026-01-01T00:00:00.000Z",
    ...(mode === undefined ? {} : { standing_mode: mode }),
  }) as Assignment;

const state = (...assignments: Assignment[]): CommandState =>
  ({
    project_id: project,
    assignments,
    cards: [],
    work_items: [],
    runs: [],
    deliveries: [],
    reviews: [],
    decisions: [],
    human_actions: [],
    attachments: [],
    roles: [],
    cursors: [],
    timeline: [],
    events: [],
  }) as unknown as CommandState;

/** The token scopes a fixture resolver can see; deliberately wrong where noted. */
const tokens =
  (scopes: Record<string, ToolName[]>) => (_project: unknown, id: string) => [
    { allowed_tools: scopes[id] ?? [] },
  ];

test("the field decides, even when the newest token disagrees", () => {
  // The Office assignment holds a token *without* record_decision and the Ops
  // assignment holds one *with* it: routing must still follow the field.
  const resolve = standingResolver(
    {} as Store,
    tokens({
      "A-1": ["whoami"],
      "A-2": ["whoami", "record_decision"],
    }),
  );
  const snapshot = state(assignment("A-1", "office"), assignment("A-2", "ops"));
  expect(resolve(project, "pm_office", snapshot)).toBe("A-1");
  expect(resolve(project, "pm_ops", snapshot)).toBe("A-2");
});

test("a legacy row without a mode falls back to its newest token", () => {
  const resolve = standingResolver(
    {} as Store,
    tokens({ "A-1": ["whoami", "record_decision"], "A-2": ["whoami"] }),
  );
  const snapshot = state(
    assignment("A-1", undefined),
    assignment("A-2", undefined),
  );
  expect(resolve(project, "pm_office", snapshot)).toBe("A-1");
  expect(resolve(project, "pm_ops", snapshot)).toBe("A-2");
});

test("suspended or work-item Assignments are never a standing recipient", () => {
  const resolve = standingResolver(
    {} as Store,
    tokens({ "A-1": ["whoami", "record_decision"], "A-2": ["whoami"] }),
  );
  const suspended = { ...assignment("A-1", "office"), status: "suspended" };
  const item = {
    ...assignment("A-2", "ops"),
    scope: "work_item",
    work_item_id: "W-1",
  } as Assignment;
  const snapshot = state(suspended as Assignment, item);
  expect(resolve(project, "pm_office", snapshot)).toBeUndefined();
  expect(resolve(project, "pm_ops", snapshot)).toBeUndefined();
});
