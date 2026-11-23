import {
  type Assignment,
  type CardId,
  createHostOpsAssignment,
  HOST_OPS_ROLE_TOOLS,
} from "@cardigan/domain";
import { HostOpsService } from "@cardigan/host";
import { authenticate, unwrap } from "@cardigan/mcp-server";
import { recordNotification } from "@cardigan/store";
import { afterEach, vi } from "vitest";
import { recoveryFixture } from "./recovery.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});
export function setup(machine_id = "local") {
  const f = recoveryFixture(machine_id);
  const { store, project, clock } = f;
  store.uow.run((tx) =>
    tx.roles.put(project, {
      role_id: "host_ops",
      role_version: 1,
      allowed_tools: HOST_OPS_ROLE_TOOLS,
      capabilities: [],
    }),
  );
  const ops = f.apply((s, a, p) =>
    createHostOpsAssignment(s, a, {}, p),
  ).assignment;
  const token = store.issueToken({
    project_id: project,
    assignment_id: ops.id,
    role: { role_version: 1, allowed_tools: HOST_OPS_ROLE_TOOLS },
  });
  const context = { identity: unwrap(authenticate(store, token.token)), store };
  const service = new HostOpsService({
    ...f.options,
    contextUsage: { execution: { mode: "local", dataDir: f.dataDir } },
  });
  cleanup.push(async () => {
    await service.close();
    f.close();
  });
  const view = async () =>
    (await service.tools.read(context)) as {
      dispatch_stalls: Array<{
        kind: string;
        cause_id: string;
        handoff_event_id?: string;
        can_restart: boolean;
        assignment_id: string;
        workspace: string;
      }>;
    };
  function event(
    type: string,
    payload: Record<string, string | boolean>,
    recipient?: "pm_ops" | "pm_office" | Assignment,
    card_id?: CardId,
  ) {
    return store.uow.run((tx) => {
      const a = typeof recipient === "object" ? recipient : undefined;
      const e = {
        type,
        payload,
        id: tx.ids.nextEventId(),
        seq: tx.ids.nextEventSequence(project, card_id),
        ...(card_id ? { card_id } : {}),
        created_at: clock.now(),
        actor: { kind: "system" as const, project_id: project },
      };
      tx.events.append(project, e);
      if (recipient)
        recordNotification(store.database, {
          project_id: project,
          event_id: e.id,
          ...(card_id ? { card_id } : {}),
          seq: e.seq,
          at: e.created_at,
          kind: "assignment",
          recipient: a
            ? { kind: "assignment", assignment_id: a.id }
            : { kind: recipient as "pm_ops" | "pm_office" },
        });
      return e;
    });
  }
  const restart = (target: Assignment, cause: string) =>
    service.tools.execute(
      context,
      target.role_id === "pm"
        ? "host_ops_restart_standing_pm"
        : "host_ops_restart_assignment",
      {
        target_id: target.id,
        reason: "fixture",
        dispatch_stall_id: cause,
        idempotency_key: `recover:${cause}`,
      },
    );
  return { ...f, ops, service, context, view, event, restart };
}
