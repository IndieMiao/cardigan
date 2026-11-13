import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Assignment, Card, Event } from "@cardigan/domain";
import { notificationsByRecipient, Store } from "@cardigan/store";
import { expect, test } from "vitest";
import {
  deploymentMergeSegments,
  writeDeploymentRecord,
} from "./deployment-audit.js";

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
    expect(deploymentMergeSegments(store, project, from, to)).toBeUndefined();
    append("merge_check_finished", {
      completion_id: "D-1",
      tree_sha: "d".repeat(40),
      status: "passed",
    });
    expect(deploymentMergeSegments(store, project, from, to)).toBeUndefined();
    append("merge_check_finished", {
      completion_id: "D-1",
      tree_sha: tree,
      status: "passed",
    });
    expect(deploymentMergeSegments(store, project, from, to)).toEqual([
      { sha: to, previous: from, tree },
    ]);
    expect(
      deploymentMergeSegments(store, project, from, "e".repeat(40)),
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
