import {
  type Assignment,
  HOST_OPS_ROLE_TOOLS,
  occupiedRunSlots,
  queueRun,
  type Runtime,
  releaseAssignment,
  updateCard,
} from "@cardigan/domain";
import {
  authenticate,
  hostOpsTools,
  loadCommandState,
  persistEffect,
  unwrap,
} from "@cardigan/mcp-server";
import { Store } from "@cardigan/store";
import { expect, test, vi } from "vitest";
import {
  assignment,
  fixture,
  human,
  id,
  now,
  role,
  run,
} from "../../domain/src/commands/test-fixtures.js";
import { HostOpsService } from "./host-ops.js";

test.each(["done", "cancelled"] as const)(
  "C-217: host cancels a Run on a %s card only after exit proof, then PM Ops can release it",
  async (status) => {
    const store = Store.open({ dbPath: ":memory:" });
    const project = human.project_id;
    let time = Date.parse(now);
    const clock = { now: () => new Date(time).toISOString() };
    const ref = {
      machine_id: "local",
      runtime_machine: "local",
      terminal_ref: "fixture",
      agent_name: "fixture",
    };
    const { work_item_id: _work, ...fields } = assignment(10, "host_ops");
    const ops: Assignment = { ...fields, scope: "standing" };
    store.createProject({ id: project });
    store.uow.run((tx) => {
      const s = fixture();
      for (const r of [
        ...s.roles,
        { ...role("host_ops"), allowed_tools: HOST_OPS_ROLE_TOOLS },
      ])
        tx.roles.put(project, r);
      for (const c of s.cards) tx.cards.put(project, c);
      for (const w of s.work_items) tx.work_items.put(project, w);
      for (const a of s.assignments)
        tx.assignments.put(
          project,
          a.id === id("assignment", 1)
            ? { ...a, runtime_state: "running", runtime_ref: ref }
            : a.scope === "standing"
              ? { ...a, standing_mode: "ops" }
              : a,
        );
      tx.assignments.put(project, ops);
      tx.runs.put(project, { ...run(1), started_at: now });
      if (status === "cancelled") {
        tx.runs.put(project, { ...run(2), status: "queued" });
        persistEffect(
          tx,
          project,
          unwrap(
            updateCard(
              loadCommandState(tx, project),
              human,
              { card_id: id("card", 1), status },
              { ids: tx.ids, clock },
            ),
          ),
        );
      } else {
        const card = s.cards[0];
        if (!card) throw new Error("Missing fixture card");
        tx.cards.put(project, { ...card, status });
      }
    });
    const read = () => store.uow.read((tx) => loadCommandState(tx, project));
    const targetToken = store.issueToken({
      project_id: project,
      assignment_id: id("assignment", 1),
      role: { role_version: 1, allowed_tools: ["whoami"] },
    });
    const opsToken = store.issueToken({
      project_id: project,
      assignment_id: ops.id,
      role: { role_version: 1, allowed_tools: HOST_OPS_ROLE_TOOLS },
    });
    const context = {
      store,
      identity: unwrap(authenticate(store, opsToken.token)),
    };
    let exited = false;
    const runtime = {
      status: vi.fn(async () => ({
        ok: true,
        value: {
          process: exited ? "exited" : "alive",
          agent: "idle",
          observed_seq: 1,
        },
      })),
      release: vi.fn(async () => ({ ok: true, value: undefined })),
      wake: vi.fn(),
    };
    const scrub = vi.fn(async () => {
      expect(exited).toBe(true);
      expect(store.verifyToken(targetToken.token)).toBeDefined();
    });
    const snapshot = vi.fn(async () => ({
      model: "test",
      agent_cli_version: "test",
    }));
    const service = new HostOpsService({
      store,
      runtime: runtime as unknown as Runtime,
      snapshot,
      scrubCredentials: scrub,
      clock,
    });
    const pmOps = {
      kind: "assignment" as const,
      project_id: project,
      assignment_id: id("assignment", 4),
      ...role("pm"),
      allowed_tools: role("pm").allowed_tools.filter(
        (t) => t !== "record_decision",
      ),
    };
    const release = () =>
      store.uow.run((tx) => {
        const effect = unwrap(
          releaseAssignment(
            loadCommandState(tx, project),
            pmOps,
            { assignment_id: id("assignment", 1) },
            { ids: tx.ids, clock },
          ),
        );
        persistEffect(tx, project, effect);
        return effect.data;
      });
    try {
      if (status === "cancelled")
        expect(read().runs.find((r) => r.id === id("run", 2))?.status).toBe(
          "cancelled",
        );
      expect(read().runs[0]?.status).toBe("running");
      expect(() => release()).toThrow();
      await expect(
        service.tools.execute(context, "host_ops_restart_assignment", {
          target_id: id("assignment", 1),
          reason: "Restart",
          idempotency_key: "no-restart",
        }),
      ).rejects.toMatchObject({ code: "illegal_transition" });
      expect(snapshot).not.toHaveBeenCalled();
      const tool = hostOpsTools({ hostOps: service.tools }).find(
        (t) => t.name === "host_ops_cancel_run",
      );
      if (!tool) throw new Error("Missing cancellation tool");
      const input = tool.input.parse({
        run_id: id("run", 1),
        reason: "Closed card cleanup",
        idempotency_key: "cancel",
      });
      const accepted = await tool.handler(input, context);
      expect(accepted).toMatchObject({ status: "pending" });
      expect(await tool.handler(input, context)).toEqual(accepted);
      expect(runtime.release).not.toHaveBeenCalled();
      await service.tick();
      expect(runtime.release).toHaveBeenCalledOnce();
      expect(scrub).not.toHaveBeenCalled();
      expect(store.verifyToken(targetToken.token)).toBeDefined();
      expect(read().runs[0]?.status).toBe("running");
      expect(occupiedRunSlots(read().assignments, read().runs, "local")).toBe(
        1,
      );
      expect(() => release()).toThrow();
      exited = true;
      time += 61_000;
      await service.tick();
      expect(scrub).toHaveBeenCalledExactlyOnceWith(
        project,
        id("assignment", 1),
        ref,
      );
      expect(store.verifyToken(targetToken.token)).toBeUndefined();
      expect(read().runs[0]).toMatchObject({
        status: "cancelled",
        outcome: "failed",
        summary: "Closed card cleanup",
      });
      expect(
        read().assignments.find((a) => a.id === id("assignment", 1)),
      ).toMatchObject({ runtime_state: "idle", runtime_ref: null });
      expect(
        read()
          .events.filter((e) =>
            [
              "host_ops_action_taken",
              "run_dispatch_aborted",
              "host_ops_action_finished",
            ].includes(e.type),
          )
          .map((e) => e.type),
      ).toEqual([
        "host_ops_action_taken",
        "run_dispatch_aborted",
        "host_ops_action_finished",
      ]);
      const stopped = read();
      expect(
        store.uow.run((tx) =>
          queueRun(
            loadCommandState(tx, project),
            human,
            {
              assignment_id: id("assignment", 1),
              model: "test",
              agent_cli_version: "test",
            },
            { clock, ids: tx.ids },
          ),
        ).ok,
      ).toBe(false);
      expect(release().status).toBe("released");
      await service.tick();
      expect(read().runs).toEqual(stopped.runs);
      expect(runtime.wake).not.toHaveBeenCalled();
    } finally {
      await service.close();
      store.close();
    }
  },
);
