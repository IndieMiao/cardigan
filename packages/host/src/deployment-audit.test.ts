import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Assignment, Card, Event } from "@cardigan/domain";
import { notificationsByRecipient, Store } from "@cardigan/store";
import { expect, test, vi } from "vitest";
import { DeploymentController } from "./deployment.js";
import {
  deploymentMergeSegments,
  writeDeploymentRecord,
} from "./deployment-audit.js";
import { readDeploymentDiagnostics } from "./deployment-diagnostics.js";
import { NodeDeploymentDriver } from "./deployment-node.js";

test.each([undefined, 42])(
  "evidence wait survives restart, alerts once at %s/default milliseconds and still requires the gate",
  async (timeout) => {
    const root = await mkdtemp(join(tmpdir(), "cg-evidence-wait-"));
    const store = Store.open({ dataDir: root, dbPath: ":memory:" });
    const from = "a".repeat(40),
      to = "b".repeat(40);
    let now = Date.parse("2026-11-14T00:00:00.000Z");
    const start = now,
      threshold = timeout ?? 600000;
    const gate = vi.fn().mockResolvedValue(false);
    const build = vi.fn().mockResolvedValue({
      build: { sha: to, release: "synthetic-release" },
      log_tail: "install: exit 0\nbuild: exit 0",
    });
    const stop = vi.fn().mockResolvedValue(undefined);
    const controller = () => {
      const d = new NodeDeploymentDriver({
        store,
        dataDir: root,
        config: {
          enabled: true,
          initial_release: root,
          initial_sha: from,
          ready_timeout_ms: 1000,
          stop_timeout_ms: 1000,
          poll_interval_ms: 1000,
          build_timeout_ms: 1000,
          ...(timeout === undefined
            ? {}
            : { evidence_wait_timeout_ms: timeout }),
        },
        env: { PRIVATE_SETTING: "synthetic-secret" },
      });
      vi.spyOn(d, "now").mockImplementation(() => now);
      vi.spyOn(d, "checkServer").mockResolvedValue();
      vi.spyOn(d, "acquire").mockResolvedValue(async () => {});
      vi.spyOn(d, "current").mockResolvedValue({ sha: from, release: root });
      vi.spyOn(d, "main").mockResolvedValue(to);
      vi.spyOn(d, "isFastForward").mockResolvedValue(true);
      vi.spyOn(d, "passedMergeGate").mockImplementation(gate);
      vi.spyOn(d, "build").mockImplementation(build);
      vi.spyOn(d, "migrationsChanged").mockResolvedValue(false);
      vi.spyOn(d, "stop").mockImplementation(stop);
      vi.spyOn(d, "start").mockResolvedValue();
      vi.spyOn(d, "ready").mockResolvedValue(true);
      vi.spyOn(d, "promote").mockResolvedValue();
      vi.spyOn(d, "refreshRoles").mockResolvedValue();
      return new DeploymentController(d);
    };
    const actions = () =>
      store.uow.read((tx) => tx.human_actions.list("cardigan"));
    try {
      store.createProject({ id: "cardigan" });
      await controller().tick();
      now = start + threshold - 1;
      await controller().tick();
      expect(actions()).toHaveLength(0);
      expect(
        (await readDeploymentDiagnostics(store, "cardigan"))?.records,
      ).toHaveLength(1);
      now++;
      gate.mockRejectedValueOnce(
        new Error("Authorization: Bearer synthetic-secret"),
      );
      await expect(controller().tick()).rejects.toThrow("synthetic-secret");
      expect(actions()).toHaveLength(0);
      await controller().tick();
      expect(actions()).toHaveLength(1);
      expect(actions()[0]).toMatchObject({
        triage: "pm_ops",
        blocked_work_items: [],
      });
      const action = actions()[0];
      if (!action) throw new Error("Missing wait action");
      store.uow.run((tx) =>
        tx.human_actions.put("cardigan", { ...action, status: "done" }),
      );
      now += threshold;
      await controller().tick();
      expect(actions()).toHaveLength(1);
      expect(build).not.toHaveBeenCalled();
      expect(stop).not.toHaveBeenCalled();
      const diagnostics = await readDeploymentDiagnostics(store, "cardigan");
      expect(diagnostics?.records).toHaveLength(2);
      expect(diagnostics?.records[0]).toMatchObject({
        waiting_since: new Date(start).toISOString(),
        evidence_wait_exceeded: true,
      });
      expect(JSON.stringify([diagnostics, actions()])).not.toMatch(
        /synthetic|Authorization|PRIVATE_SETTING/,
      );
      gate.mockResolvedValue(true);
      await controller().tick();
      expect(build).toHaveBeenCalledOnce();
      expect(
        (await readDeploymentDiagnostics(store, "cardigan"))?.records[0]
          ?.status,
      ).toBe("deployed");
    } finally {
      store.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);

test("changing candidates restarts the wait and a returning candidate cannot create a second action", async () => {
  const root = await mkdtemp(join(tmpdir(), "cg-evidence-candidates-"));
  const store = Store.open({ dataDir: root, dbPath: ":memory:" });
  try {
    store.createProject({ id: "cardigan" });
    const observe = (to: string, now: number) =>
      writeDeploymentRecord(
        store,
        "cardigan",
        {
          attempt: "fixture",
          from: "a".repeat(40),
          to: to.repeat(40),
          status: "waiting_for_evidence",
          build: "not_run",
          ready: false,
          downtime_ms: 0,
          summary: "等待门禁",
        },
        { timeout_ms: 100, now },
      );
    observe("b", 0);
    observe("c", 99);
    observe("c", 100);
    expect(
      store.uow.read((tx) => tx.human_actions.list("cardigan")),
    ).toHaveLength(0);
    observe("c", 199);
    observe("b", 200);
    observe("b", 300);
    observe("c", 301);
    observe("c", 401);
    expect(
      store.uow.read((tx) => tx.human_actions.list("cardigan")),
    ).toHaveLength(2);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("every main segment requires a real passed gate; failed deploy notifies Office and host ops", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "cg-deployment-audit-"));
  const store = Store.open({ dataDir });
  const project = "fixture";
  const from = "a".repeat(40),
    to = "b".repeat(40),
    tree = "c".repeat(40);
  const card: Card = {
    id: "C-1" as never,
    project_id: project,
    title: "Deployment",
    goal: "Test",
    acceptance_criteria: ["Test"],
    source: { kind: "quote", text: "Test" },
    out_of_scope: [],
    related_cards: [],
    priority: 1,
    status: "done",
    template: "dev",
    merge_policy: "confirm",
    created_by: "human",
    created_at: "2026-01-01T00:00:00.000Z",
  };
  try {
    store.createProject({ id: project });
    const append = (type: string, payload: Event["payload"]) =>
      store.uow.run((tx) => {
        tx.cards.put(project, card);
        tx.events.append(project, {
          id: tx.ids.nextEventId(),
          card_id: card.id,
          seq: tx.ids.nextEventSequence(project, card.id),
          type,
          payload,
          actor: { kind: "system", project_id: project },
          created_at: card.created_at,
        });
      });
    append("card_merged", {
      completion_id: "D-1",
      result: {
        kind: "merged",
        previous_sha: from,
        merge_sha: to,
        tree_sha: tree,
      },
    });
    expect(
      await deploymentMergeSegments(store, project, from, to),
    ).toBeUndefined();
    append("merge_check_finished", {
      completion_id: "D-1",
      tree_sha: "d".repeat(40),
      status: "passed",
    });
    expect(
      await deploymentMergeSegments(store, project, from, to),
    ).toBeUndefined();
    append("merge_check_finished", {
      completion_id: "D-1",
      tree_sha: tree,
      status: "passed",
    });
    expect(await deploymentMergeSegments(store, project, from, to)).toEqual([
      { sha: to, previous: from, tree },
    ]);
    expect(
      await deploymentMergeSegments(store, project, from, "e".repeat(40)),
    ).toBeUndefined();
    store.uow.run((tx) => {
      for (const [n, role, mode] of [
        [1, "pm", "office"],
        [2, "pm", "ops"],
        [3, "host_ops", undefined],
      ] as const) {
        tx.assignments.put(project, {
          id: `A-${n}`,
          scope: "standing",
          role_id: role,
          ...(mode ? { standing_mode: mode } : {}),
          role_version: 1,
          status: "active",
          runtime_state: "not_provisioned",
          machine_id: "local",
          runtime_ref: null,
          mcp_token_id: `fixture-${n}`,
          created_at: card.created_at,
        } as Assignment);
      }
    });
    writeDeploymentRecord(store, project, {
      attempt: "test",
      from,
      to,
      status: "rolled_back",
      build: "passed",
      ready: true,
      downtime_ms: 20,
      summary: "Restored previous build",
    });
    expect(store.uow.read((tx) => tx.human_actions.list(project))).toHaveLength(
      1,
    );
    for (const id of ["A-1", "A-3"])
      expect(
        notificationsByRecipient(store.database, project).get(
          `assignment:${id}`,
        ),
      ).toHaveLength(1);
  } finally {
    store.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});
