import type { CommandPorts, Event, ProjectId } from "@cardigan/domain";
import { Store } from "@cardigan/store";
import { expect, test } from "vitest";
import { fixture } from "../../domain/src/commands/test-fixtures.js";
import { authenticate } from "./auth.js";
import { executeCommand } from "./commands/execute.js";

const sha = "b".repeat(40);
function deployment(project: ProjectId, id: string, status: string): Event {
  return {
    id: id as Event["id"],
    seq: Number(id.slice(-1)),
    type: "host_deployment_recorded",
    actor: { kind: "system", project_id: project },
    payload: { from: "a".repeat(40), to: sha, status, ready: true },
    created_at: "2026-01-01T00:00:00.000Z",
  };
}

test("C-622: MCP commands receive a read-only reader of other projects' host deployments", () => {
  const state = fixture();
  const project = state.project_id;
  const platform = "p-platform" as ProjectId;
  const store = Store.open({ dbPath: ":memory:" });
  try {
    store.createProject({ id: project });
    store.createProject({ id: platform });
    store.uow.run((tx) => {
      for (const v of state.cards) tx.cards.put(project, v);
      for (const v of state.work_items) tx.work_items.put(project, v);
      for (const v of state.assignments) tx.assignments.put(project, v);
      for (const v of state.roles) tx.roles.put(project, v);
      tx.events.append(
        platform,
        deployment(platform, "00000000000000000000000001", "stopping"),
      );
      tx.events.append(
        platform,
        deployment(platform, "00000000000000000000000002", "deployed"),
      );
      // The command's own project is excluded; its records are already in state.
      tx.events.append(
        project,
        deployment(project, "00000000000000000000000003", "deployed"),
      );
    });
    const issued = store.issueToken({
      project_id: project,
      assignment_id: state.assignments[0]?.id ?? ("A-1" as never),
      role: { role_version: 1, allowed_tools: ["report_blocker"] },
    });
    const auth = authenticate(store, issued.token);
    if (!auth.ok) throw new Error("Missing identity");
    let seen: CommandPorts | undefined;
    const read = executeCommand(
      { store, identity: auth.value },
      "report_blocker",
      "platform-reader",
      {},
      (_state, _actor, _params, ports) => {
        seen = ports;
        return {
          ok: true,
          value: {
            data: ports.platform_deployments?.(project, sha) ?? [],
            changes: [],
            events: [],
            timeline: [],
            token_requests: [],
          },
        };
      },
    );
    expect(seen?.platform_deployments).toBeTypeOf("function");
    expect(read.map((e) => [e.actor.project_id, e.payload])).toEqual([
      [platform, expect.objectContaining({ status: "stopping" })],
      [platform, expect.objectContaining({ status: "deployed" })],
    ]);
    expect(seen?.platform_deployments?.(project, "c".repeat(40)) ?? []).toEqual(
      [],
    );
  } finally {
    store.close();
  }
});
