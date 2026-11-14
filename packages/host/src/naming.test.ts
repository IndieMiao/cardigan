import { expect, test } from "vitest";
import { agentNameFor } from "./naming.js";

test("names hash the complete project, Assignment and execution identity within the hc limit", () => {
  const input = {
    role_id: "a-very-long-role",
    project_id: `p-${"x".repeat(200)}`,
    assignment_id: `A-${"1234".repeat(80)}`,
    machine_id: "worker-a",
    execution_identity: "one",
  };
  const name = agentNameFor(input);
  expect(name).toMatch(/^[a-z0-9_-]{1,32}$/u);
  expect(agentNameFor(input)).toBe(name);
  const names = [
    name,
    ...[
      { project_id: `q-${"x".repeat(200)}` },
      { assignment_id: `A-9${"1234".repeat(80)}` },
      { machine_id: "worker-b" },
      { execution_identity: "two" },
    ].map((patch) => agentNameFor({ ...input, ...patch })),
  ];
  expect(new Set(names).size).toBe(names.length);
});
