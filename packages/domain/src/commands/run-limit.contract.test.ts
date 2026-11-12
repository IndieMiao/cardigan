import { expect, test, vi } from "vitest";
import type { Actor, Machine } from "../entities.js";
import type { AssignmentId, EventId, MemberId } from "../ids.js";
import { setRunLimit } from "./run-limit.js";

const machine: Machine = {
  id: "local",
  label: "Workstation",
  status: "online",
  herdr_machine: "local",
  os: "linux",
  arch: "x64",
  tags: [],
  max_assignments: 4,
  last_seen: "2026-11-12T00:00:00.000Z",
};
const context = () => ({
  machines: [machine],
  previous: 4,
  member_id: "M-1" as MemberId,
  clock: { now: () => "2026-11-12T00:00:00.000Z" },
  ids: {
    nextEventId: vi.fn(() => "event-1" as EventId),
    nextEventSequence: vi.fn(() => 1),
  },
});

test.each([undefined, 8, 32])(
  "capacity cannot exceed the trusted ceiling %s, with no audit on rejection",
  (maximum) => {
    const cap = maximum ?? 16;
    const ports = {
      ...context(),
      ...(maximum === undefined ? {} : { maximum }),
    };
    expect(
      setRunLimit(
        { kind: "human" },
        { machine_id: "local", limit: cap + 1 },
        ports,
      ),
    ).toMatchObject({
      ok: false,
      error: {
        code: "validation_failed",
        message: `并发上限不能超过 ${cap}。`,
      },
    });
    expect(ports.ids.nextEventId).not.toHaveBeenCalled();
    expect(ports.ids.nextEventSequence).not.toHaveBeenCalled();
    expect(
      setRunLimit(
        { kind: "human" },
        { machine_id: "local", limit: cap },
        ports,
      ),
    ).toMatchObject({ ok: true, value: { setting: { limit: cap } } });
  },
);

test.each([0, -1, 1.5, NaN, Infinity])(
  "invalid trusted ceiling %s cannot authorize a write",
  (maximum) => {
    const ports = { ...context(), maximum };
    expect(
      setRunLimit({ kind: "human" }, { machine_id: "local", limit: 1 }, ports)
        .ok,
    ).toBe(false);
    expect(ports.ids.nextEventId).not.toHaveBeenCalled();
  },
);

test.each(["coder", "pm", "host_ops"])(
  "%s cannot change global capacity even with tool grants",
  (role_id) => {
    const actor: Actor = {
      kind: "assignment",
      project_id: "p",
      assignment_id: "A-1" as AssignmentId,
      role_id,
      role_version: 1,
      allowed_tools: ["create_card", "assign", "host_ops_cancel_run"],
      capabilities: [],
    };
    const ports = context();
    expect(
      setRunLimit(actor, { machine_id: "local", limit: 6 }, ports),
    ).toMatchObject({ ok: false, error: { code: "forbidden_tool" } });
    expect(ports.ids.nextEventId).not.toHaveBeenCalled();
  },
);

test("system is also denied; human changes audit the old effective value and member", () => {
  expect(
    setRunLimit(
      { kind: "system", project_id: "p" },
      { machine_id: "local", limit: 6 },
      context(),
    ).ok,
  ).toBe(false);
  expect(
    setRunLimit(
      { kind: "human" },
      { machine_id: "local", limit: 2 },
      context(),
    ),
  ).toEqual({
    ok: true,
    value: {
      setting: {
        machine_id: "local",
        limit: 2,
        updated_by: "M-1",
        updated_at: "2026-11-12T00:00:00.000Z",
      },
      event: {
        id: "event-1",
        seq: 1,
        type: "run_capacity_updated",
        actor: { kind: "human" },
        created_at: "2026-11-12T00:00:00.000Z",
        payload: {
          machine_id: "local",
          member_id: "M-1" as MemberId,
          old_value: 4,
          new_value: 2,
        },
      },
    },
  });
});

test("invalid values, unregistered machines and invalid host defaults have no effects", () => {
  for (const limit of [
    0,
    -1,
    1.5,
    Number.NaN,
    Infinity,
    Number.MAX_SAFE_INTEGER + 1,
  ]) {
    const ports = context();
    expect(
      setRunLimit({ kind: "human" }, { machine_id: "local", limit }, ports),
    ).toMatchObject({ ok: false, error: { code: "validation_failed" } });
    expect(ports.ids.nextEventSequence).not.toHaveBeenCalled();
  }
  expect(
    setRunLimit({ kind: "human" }, { machine_id: "ci", limit: 3 }, context()),
  ).toMatchObject({ ok: false, error: { code: "not_found" } });
  expect(
    setRunLimit(
      { kind: "human" },
      { machine_id: "local", limit: 3 },
      { ...context(), previous: 0 },
    ),
  ).toMatchObject({ ok: false, error: { code: "validation_failed" } });
});
