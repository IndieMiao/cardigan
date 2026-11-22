import type { Runtime } from "@cardigan/domain";
import {
  acknowledgeRun,
  dispatchRun,
  finishRun,
  postComment,
} from "@cardigan/domain";
import {
  getRoleVersion,
  PROJECT_EVENT_STREAM,
  writeRole,
} from "@cardigan/store";
import { vi } from "vitest";
import type { DispatcherOptions } from "../src/dispatch.js";
import { dispatchFixture } from "./dispatch.js";

export function recoveryFixture(machine_id = "local", migrationsDir?: string) {
  const f = dispatchFixture(machine_id, "none", "linux", migrationsDir),
    target = f.create();
  f.session(target.assignment);
  const stopped = new Set<string>();
  const working = new Set<string>();
  const runtime: Runtime = {
    status: vi.fn(async (ref) => ({
      ok: true,
      value: {
        process: stopped.has(ref.terminal_ref) ? "exited" : "alive",
        agent: working.has(ref.terminal_ref) ? "working" : "idle",
        observed_seq: 1,
      },
    })),
    wake: vi.fn(async () => ({ ok: true, value: { sent: true } })),
    provision: vi.fn(),
    release: vi.fn(async (ref) => {
      stopped.add(ref.terminal_ref);
      return { ok: true, value: undefined };
    }),
    interrupt: vi.fn(),
    resume_or_replace: vi.fn(),
    human_entry: vi.fn(),
  };
  const options: DispatcherOptions = {
    store: f.store,
    runtime,
    clock: f.clock,
    snapshot: async () => ({ model: "fixture", agent_cli_version: "fixture" }),
    startRun: vi.fn(async ({ run, assignment }) => {
      const ref = f.refFor(assignment);
      stopped.delete(ref.terminal_ref);
      f.apply((s, a, p) =>
        dispatchRun(s, a, { run_id: run.id, runtime_ref: ref }, p),
      );
    }),
  };
  const skipEvents = () => {
    for (const card of [undefined, ...f.state().cards.map((c) => c.id)])
      f.store.advanceRouterCursor(
        f.project,
        card ?? PROJECT_EVENT_STREAM,
        f.store.getUpdates({
          project_id: f.project,
          ...(card ? { card_id: card } : {}),
        }).latest_seq,
      );
  };
  skipEvents();
  const comment = () =>
    f.apply((s, a, p) =>
      postComment(
        s,
        a,
        {
          card_id: target.card.id,
          work_item_id: target.item.id,
          body: "Read updates",
        },
        p,
      ),
    );
  const latest = () => {
    const r = f
      .state()
      .runs.filter((r) => r.assignment_id === target.assignment.id)
      .at(-1);
    if (!r) throw new Error("Missing Run");
    return r;
  };
  const complete = () => {
    const run = latest();
    f.apply(
      (s, a, p) => acknowledgeRun(s, a, { run_id: run.id }, p),
      f.actorFor(target.assignment),
    );
    f.apply(
      (s, a, p) =>
        finishRun(
          s,
          a,
          { run_id: run.id, outcome: "completed", summary: "fixture" },
          p,
        ),
      f.actorFor(target.assignment),
    );
  };
  const pm = () =>
    f.store.uow.run((tx) => {
      const role = getRoleVersion(tx, f.project, "coder");
      if (!role) throw new Error("Missing role");
      if (!getRoleVersion(tx, f.project, "pm"))
        writeRole(
          tx,
          f.project,
          {
            ...role,
            role_id: "pm",
            kind: "standing",
            capabilities: ["manage"],
          },
          { mode: "add" },
        );
      const a = {
        id: tx.ids.next(f.project, "assignment"),
        scope: "standing" as const,
        role_id: "pm",
        role_version: 1,
        status: "active" as const,
        runtime_state: "not_provisioned" as const,
        runtime_ref: null,
        machine_id: "local",
        mcp_token_id: "reserved",
        created_at: f.clock.now(),
      };
      tx.assignments.put(f.project, a);
      return a;
    });
  /** Opt in to owner-bound evidence: these terminals carry this Assignment's
   * labels. Mirrors the adapter: a live terminal that is not idle/done is unknown. */
  const ownTerminals = () => {
    runtime.observe_retirement = vi.fn(async (ref) => {
      const seen = await runtime.status(ref);
      return {
        ok: true as const,
        value:
          stopped.has(ref.terminal_ref) ||
          (seen.ok && seen.value.process === "exited")
            ? ("exited" as const)
            : seen.ok &&
                seen.value.process === "alive" &&
                ["idle", "done"].includes(seen.value.agent)
              ? ("alive" as const)
              : ("unknown" as const),
      };
    });
    // The gentle owner-bound stop used by stall recovery; exit is kernel-checked.
    runtime.retire_idle = vi.fn<NonNullable<Runtime["retire_idle"]>>(
      async (ref, options) => {
        if (stopped.has(ref.terminal_ref))
          return { ok: true, value: { outcome: "exited" } };
        if (
          working.has(ref.terminal_ref) ||
          ("workspace_preflight" in options &&
            options.workspace_preflight &&
            !(await options.workspace_preflight())) ||
          !options.before_signal()
        )
          return {
            ok: true,
            value: {
              outcome: "withdrawn",
              evidence: { stage: "TERM", reason: "guard_changed" },
            },
          };
        stopped.add(ref.terminal_ref);
        return {
          ok: true,
          value: { outcome: "exited", process_group_exited: true },
        };
      },
    );
  };
  return {
    ...f,
    ownTerminals,
    target,
    working,
    runtime,
    options,
    skipEvents,
    comment,
    latest,
    complete,
    pm,
    notes: () =>
      f.store.listNotifications({
        project_id: f.project,
        assignment_id: target.assignment.id,
      }),
  };
}
