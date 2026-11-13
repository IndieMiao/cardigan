import { expect, test } from "vitest";
import { recordDeployment, requestDeploymentAction } from "./deployment.js";
import { actor, apply, fixture, human, ports, value } from "./test-fixtures.js";

const record = {
  attempt: "attempt",
  from: "a".repeat(40),
  to: "b".repeat(40),
  status: "deployed" as const,
  build: "passed" as const,
  ready: true,
  downtime_ms: 10,
  summary: "ready",
};

test("deployment audit is system-only; no Agent can forge a successful deployment", () => {
  const state = fixture();
  for (const caller of [
    human,
    actor(1, "coder"),
    actor(4, "pm"),
    actor(5, "host_ops"),
    { kind: "system" as const, project_id: "other" },
  ]) {
    expect(recordDeployment(state, caller, record, ports()).ok).toBe(false);
    expect(
      requestDeploymentAction(
        state,
        caller,
        { key: "key", instructions: "help" },
        ports(),
      ).ok,
    ).toBe(false);
  }
  const system = { kind: "system" as const, project_id: state.project_id };
  const result = value(recordDeployment(state, system, record, ports()));
  expect(result.events[0]).toMatchObject({
    type: "host_deployment_recorded",
    actor: system,
    payload: record,
  });
  expect(
    recordDeployment(state, system, { ...record, from: "main" }, ports()).ok,
  ).toBe(false);
});

test("permission-widening followup stays with the human and is idempotent", () => {
  const state = fixture();
  const system = { kind: "system" as const, project_id: state.project_id };
  const p = { key: "role:pm:version", instructions: "Review the dry-run diff" };
  const effect = value(requestDeploymentAction(state, system, p, ports()));
  expect(effect.data).toMatchObject({
    status: "open",
    triage: "human",
    requested_by: "system",
  });
  const again = value(
    requestDeploymentAction(apply(state, effect), system, p, ports()),
  );
  expect(again.events).toEqual([]);
  expect(again.data.id).toBe(effect.data.id);
});
