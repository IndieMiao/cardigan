import {
  type Assignment,
  type CommandState,
  type Employee,
  postComment,
} from "@cardigan/domain";
import { expect, test } from "vitest";
import {
  actor,
  apply,
  assignment,
  fixture,
  human,
  id,
  now,
  ports,
  value,
} from "../../domain/src/commands/test-fixtures.js";
import { routeEvent } from "./route.js";

const employee: Employee = {
  id: id("employee", 1),
  name: "Mary Jane",
  title: "开发",
  bio: "",
  avatar: null,
  role_id: "coder",
  launch_profile_ref: null,
  status: "active",
  created_at: now,
  updated_at: now,
};
function state(): CommandState {
  return {
    ...fixture(),
    employees: [employee],
    assignments: [
      { ...assignment(), employee_id: employee.id },
      assignment(2, "reviewer"),
      assignment(3, "pm"),
    ],
  };
}
function route(s = state(), body = "请 @mArY　jAnE 看一下", agent = false) {
  const effect = value(
    postComment(
      s,
      agent ? actor(3, "pm") : human,
      { card_id: id("card", 1), body },
      ports(),
    ),
  );
  const event = effect.events[0];
  if (event === undefined) throw new Error("No comment event");
  return routeEvent({ event, snapshot: apply(s, effect) });
}
const recipients = (result: ReturnType<typeof route>) =>
  result.notifications.map((n) => n.recipient);

test.each([false, true])(
  "human/agent employee mentions ring the unique active Assignment (agent=%s)",
  (agent) => {
    expect(recipients(route(state(), undefined, agent))).toEqual([
      { kind: "assignment", assignment_id: "A-1" },
    ]);
  },
);
test("multiple active Assignments require a work item and never broadcast", () => {
  const s = state();
  const result = route({
    ...s,
    assignments: [
      ...s.assignments,
      { ...assignment(3), employee_id: employee.id },
    ],
  });
  expect(result.notifications).toEqual([]);
  expect(result.problems).toEqual([
    expect.objectContaining({
      code: "ambiguous_employee_mention",
      detail: expect.stringContaining("@W-n"),
    }),
  ]);
});
test.each(["suspended", "released"] as const)(
  "%s and other-card/standing Assignments do not count as assignments on this card",
  (status) => {
    const s = state();
    const elsewhere: Assignment = {
      ...assignment(2),
      employee_id: employee.id,
    };
    const result = route({
      ...s,
      assignments: [
        { ...assignment(), employee_id: employee.id, status },
        elsewhere,
        { ...assignment(4), scope: "standing", employee_id: employee.id },
      ],
      work_items: s.work_items.map((item) =>
        item.id === id("work_item", 2)
          ? { ...item, card_id: id("card", 2) }
          : item,
      ),
    });
    expect(recipients(result)).toEqual([{ kind: "pm_ops" }]);
    expect(result.notifications[0]?.rule).toBe(
      "6.5/no assignment for the employee",
    );
  },
);
test("an active employee with no assignment goes to PM Ops", () => {
  expect(recipients(route({ ...state(), assignments: [] }))).toEqual([
    { kind: "pm_ops" },
  ]);
});
test("unknown and inactive names follow ordinary comment behavior", () => {
  for (const employees of [
    [],
    [{ ...employee, status: "inactive" as const }],
  ]) {
    const result = route({ ...state(), employees }, "@Mary Jane", true);
    expect(result.notifications).toEqual([]);
    expect(result.problems).toEqual([]);
  }
});
test("Chinese employee names coexist with roles and preserve recipient deduplication", () => {
  const s = { ...state(), employees: [{ ...employee, name: "诸葛亮" }] };
  expect(recipients(route(s, "@诸葛亮 和 @reviewer 与 @coder"))).toEqual([
    { kind: "assignment", assignment_id: "A-1" },
    { kind: "assignment", assignment_id: "A-2" },
  ]);
});

test("an employee becoming inactive before routing remains ordinary text", () => {
  const s = state();
  const effect = value(
    postComment(
      s,
      human,
      { card_id: id("card", 1), body: "@Mary Jane" },
      ports(),
    ),
  );
  const event = effect.events[0];
  if (event === undefined) throw new Error("No comment event");
  const result = routeEvent({
    event,
    snapshot: {
      ...apply(s, effect),
      employees: [{ ...employee, status: "inactive" }],
    },
  });
  expect(result.problems).toEqual([]);
  expect(result.notifications).toEqual([
    expect.objectContaining({
      recipient: { kind: "pm_ops" },
      rule: "6.4/card comment without mention",
    }),
  ]);
});

test("employee names cannot override explicit Assignment IDs, and a sender never rings itself", () => {
  const s = state();
  const effect = value(
    postComment(
      { ...s, employees: [{ ...employee, name: "A-2" }] },
      actor(),
      {
        card_id: id("card", 1),
        body: "@A-2",
        mentions: ["@A-2"],
      },
      ports(),
    ),
  );
  const event = effect.events[0];
  if (event === undefined) throw new Error("No comment event");
  expect(
    recipients(
      routeEvent({
        event,
        snapshot: apply(
          { ...s, employees: [{ ...employee, name: "A-2" }] },
          effect,
        ),
      }),
    ),
  ).toEqual([{ kind: "assignment", assignment_id: "A-2" }]);
  const own = value(
    postComment(
      s,
      actor(),
      { card_id: id("card", 1), body: "@Mary Jane" },
      ports(),
    ),
  );
  const ownEvent = own.events[0];
  if (ownEvent === undefined) throw new Error("No comment event");
  expect(
    routeEvent({ event: ownEvent, snapshot: apply(s, own) }).notifications,
  ).toEqual([]);
});
