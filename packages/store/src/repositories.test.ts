import { expect, test } from "vitest";
import { updateMachineDescription } from "./machines.js";
import { Store } from "./store.js";
import {
  assignment,
  card,
  project_id,
  withTempStore,
  workItem,
} from "./test-support.js";

test("shared machine descriptions publish atomically, invalidate both projects and roll back conflicts", () => {
  withTempStore((store, dataDir) => {
    store.createProject({ id: "project-a" });
    store.createProject({ id: "project-b" });
    const other = Store.open({ dataDir });
    const read = () =>
      other.uow.read((tx) => [
        tx.machines.list("project-a"),
        tx.machines.list("project-b"),
      ]);
    try {
      const before = read();
      const description = {
        id: "local",
        label: "Shared Host",
        os: "darwin",
        arch: "arm64",
      };
      expect(() =>
        updateMachineDescription(store.database, description),
      ).toThrow(/requires a write transaction/);
      store.uow.run(() => {
        const result = updateMachineDescription(store.database, description);
        expect(result.map((p) => p.project_id)).toEqual([
          "project-a",
          "project-b",
        ]);
        expect(read()).toEqual(before);
      });
      const committed = read();
      expect(committed).toEqual(
        before.map((machines) =>
          machines.map((machine) => ({ ...machine, ...description })),
        ),
      );
      const local = committed[0]?.[0];
      if (!local) throw new Error("missing local");
      store.uow.run((tx) =>
        tx.machines.put("project-a", {
          ...local,
          id: "worker-a",
          label: "Worker A",
          herdr_machine: "worker-a",
        }),
      );
      const rows = () =>
        store.database
          .prepare("SELECT * FROM machines ORDER BY project_id, id")
          .all();
      const beforeConflict = rows();
      // The helper's savepoint restores rows even when its caller catches the error.
      store.uow.run(() => {
        expect(() =>
          updateMachineDescription(store.database, {
            ...description,
            label: "Worker A",
          }),
        ).toThrow(/physical identity/);
        expect(rows()).toEqual(beforeConflict);
      });
      // Fail only after the first project's row was reinserted.
      store.database.exec(
        "CREATE TRIGGER fail_description BEFORE INSERT ON machines WHEN NEW.project_id = 'project-b' AND json_extract(NEW.doc, '$.label') = 'Failed Host' BEGIN SELECT RAISE(ABORT, 'fixture insert failure'); END",
      );
      expect(() =>
        store.uow.run(() =>
          updateMachineDescription(store.database, {
            ...description,
            label: "Failed Host",
          }),
        ),
      ).toThrow("fixture insert failure");
      expect(rows()).toEqual(beforeConflict);
      expect(read()[1]).toEqual(committed[1]);
    } finally {
      other.close();
    }
  });
});

test("Assignment machines cannot be changed through columns, documents, upserts or another connection", () => {
  withTempStore((store, dataDir) => {
    store.uow.run((tx) => tx.assignments.put(project_id, assignment()));
    const other = Store.open({ dataDir });
    try {
      const before = other.database.prepare("SELECT * FROM assignments").all();
      for (const sql of [
        "UPDATE assignments SET machine_id = 'worker-a'",
        "UPDATE assignments SET doc = json_set(doc, '$.machine_id', 'worker-a')",
        "UPDATE assignments SET machine_id = 'worker-a', doc = json_set(doc, '$.machine_id', 'worker-a')",
        "UPDATE assignments SET doc = json_remove(doc, '$.machine_id')",
        "INSERT OR REPLACE INTO assignments (project_id, id, machine_id, mcp_token_id, doc) SELECT project_id, id, 'worker-a', mcp_token_id, json_set(doc, '$.machine_id', 'worker-a') FROM assignments",
      ])
        expect(() => other.database.exec(sql)).toThrow(/machine_id/);
      expect(() =>
        other.uow.run((tx) =>
          tx.assignments.put(
            project_id,
            assignment({ machine_id: "worker-a" }),
          ),
        ),
      ).toThrow(/machine_id/);
      expect(other.database.prepare("SELECT * FROM assignments").all()).toEqual(
        before,
      );
      expect(() =>
        other.database
          .prepare(
            "INSERT INTO assignments (project_id, id, machine_id, mcp_token_id, doc) VALUES (?, ?, ?, ?, ?)",
          )
          .run(
            project_id,
            "A-2",
            "local",
            "different",
            JSON.stringify(assignment({ id: "A-2", machine_id: "worker-a" })),
          ),
      ).toThrow(/machine_id/);
      other.uow.run((tx) =>
        tx.assignments.put(project_id, assignment({ runtime_state: "idle" })),
      );
    } finally {
      other.close();
    }
  });
});

test("cross-project machine identity conflicts roll back every registration write", () => {
  withTempStore((store, dataDir) => {
    store.createProject({ id: project_id });
    const local = store.uow.read((tx) => tx.machines.get(project_id, "local"));
    if (!local) throw new Error("missing local");
    const remote = {
      ...local,
      id: "worker-a",
      label: "Worker A",
      herdr_machine: "worker-a",
    };
    const other = Store.open({ dataDir });
    try {
      other.database.exec("PRAGMA busy_timeout = 0");
      expect(() =>
        store.uow.run((tx) => {
          tx.machines.put(project_id, remote);
          // The competing connection cannot observe or replace this uncommitted registry row.
          expect(() =>
            other.uow.run((otherTx) =>
              otherTx.machines.put("other", { ...remote, os: "different" }),
            ),
          ).toThrow(/locked|busy/i);
          throw new Error("registration rollback");
        }),
      ).toThrow("registration rollback");
      expect(
        store.uow.read((tx) => tx.machines.get(project_id, remote.id)),
      ).toBeUndefined();
      store.uow.run((tx) => tx.machines.put(project_id, remote));
      expect(() =>
        other.uow.run((tx) =>
          tx.machines.put(project_id, {
            ...remote,
            id: "alias",
            label: "Alias",
          }),
        ),
      ).toThrow(/physical identity/);
      for (const patch of [
        { os: "different" },
        { arch: "different" },
        { label: "Other" },
      ]) {
        expect(() =>
          other.uow.run((tx) => {
            tx.machines.put("other", {
              ...remote,
              id: "worker-b",
              label: "Worker B",
            });
            tx.machines.put("other", { ...remote, ...patch });
          }),
        ).toThrow(/physical identity/);
        expect(other.uow.read((tx) => tx.machines.list("other"))).toEqual([]);
      }
      expect(() =>
        other.uow.run((tx) =>
          tx.machines.put("other", { ...remote, id: "alias" }),
        ),
      ).toThrow(/physical identity/);
      other.uow.run((tx) =>
        tx.machines.put("other", {
          ...remote,
          herdr_machine: "project-b-alias",
        }),
      );
      expect(
        other.uow.read((tx) => tx.machines.get("other", remote.id))?.id,
      ).toBe(remote.id);
    } finally {
      other.close();
    }
  });
});

/**
 * Every M1.1 entity must round-trip through its table, so a mismatch between a
 * table's columns and the values a repository binds fails here instead of in a
 * later milestone.
 */
test("every entity table round-trips its entity", () => {
  withTempStore((store) => {
    const role = {
      role_id: "coder",
      role_version: 1,
      allowed_tools: ["whoami" as const],
      capabilities: ["code"],
    };
    const machine = {
      id: "local",
      label: "local",
      herdr_machine: "local",
      os: "linux",
      arch: "x64",
      tags: [],
      max_assignments: 2,
      status: "online" as const,
      last_seen: "2026-01-01T00:00:00.000Z",
    };
    const run = {
      id: "R-1" as never,
      assignment_id: assignment().id,
      trigger_event_id: "01J0000000000000000000000A" as never,
      kind: "initial" as const,
      status: "queued" as const,
      role_version: 1,
      model: "fictional-model",
      agent_cli_version: "0.0.1",
      outcome: null,
      summary: "",
    };
    const delivery = {
      id: "D-1" as never,
      work_item_id: workItem().id,
      run_id: run.id,
      kind: "code" as const,
      summary: "fictional delivery",
      subject: { kind: "git_head" as const, value: "abc123" },
      evidence: [],
      attachments: [],
      known_gaps: [],
      requested_verifiers: [],
      status: "submitted" as const,
    };
    const review = {
      id: "V-1" as never,
      delivery_id: delivery.id,
      target_sha: "abc123",
      work_item_id: workItem().id,
      run_id: run.id,
      kind: "code" as const,
      issues: [],
      verdict: "pass" as const,
      blocking: false,
      recheck_required: false,
      attachments: [],
    };
    const decision = {
      id: "q(1)" as never,
      key: "q(1)" as never,
      kind: "choose" as const,
      raised_by: "human",
      question: "fictional question",
      human_required_reason: "数值规则须由人确认",
      context: "",
      options: [],
      recommended: "a",
      affected_cards: [],
      affected_work_items: [],
      blocking: false,
      decider: "human" as const,
      doc_refs: [],
      status: "open" as const,
    };
    const humanAction = {
      id: "h(1)" as never,
      key: "h(1)" as never,
      requested_by: "human",
      instructions: "do the fictional thing",
      why_human: "only a human can",
      expected_return: "say done",
      blocked_work_items: [],
      status: "open" as const,
    };
    const attachment = {
      id: "attachment-1",
      kind: "evidence" as const,
      sha256: "f".repeat(64),
      mime: "text/plain",
      original_filename: "截图.txt",
      note: "修复后的结果",
      size: 3,
      card_id: card().id,
      uploaded_by: "human",
      storage_path: "attachments/fictional.txt",
      attach_to: { kind: "delivery" as const, id: delivery.id },
    };

    store.uow.run((tx) => {
      tx.roles.put(project_id, role);
      tx.machines.put(project_id, machine);
      tx.cards.put(project_id, card());
      tx.work_items.put(project_id, workItem());
      tx.assignments.put(project_id, assignment());
      tx.runs.put(project_id, run);
      tx.deliveries.put(project_id, delivery);
      tx.reviews.put(project_id, review);
      tx.decisions.put(project_id, decision);
      tx.human_actions.put(project_id, humanAction);
      tx.attachments.put(project_id, attachment);
      const { original_filename: _name, note: _note, ...legacy } = attachment;
      tx.attachments.put(project_id, { ...legacy, id: "attachment-legacy" });
    });

    store.uow.run((tx) => {
      expect(
        tx.roles.get(project_id, { role_id: "coder", role_version: 1 }),
      ).toEqual(role);
      expect(tx.machines.get(project_id, machine.id)).toEqual(machine);
      expect(tx.cards.get(project_id, card().id)).toEqual({
        ...card(),
        flow_version: 1,
      });
      expect(tx.work_items.get(project_id, workItem().id)).toEqual(workItem());
      expect(tx.assignments.get(project_id, assignment().id)).toEqual(
        assignment(),
      );
      expect(tx.runs.get(project_id, run.id)).toEqual(run);
      expect(tx.deliveries.get(project_id, delivery.id)).toEqual(delivery);
      expect(tx.reviews.get(project_id, review.id)).toEqual(review);
      expect(tx.decisions.get(project_id, decision.id)).toEqual(decision);
      expect(tx.human_actions.get(project_id, humanAction.id)).toEqual(
        humanAction,
      );
      expect(tx.attachments.get(project_id, attachment.id)).toEqual(attachment);
      const legacy = tx.attachments.get(project_id, "attachment-legacy");
      expect(legacy).toMatchObject({
        sha256: attachment.sha256,
        mime: attachment.mime,
      });
      expect(legacy).not.toHaveProperty("original_filename");
      expect(legacy).not.toHaveProperty("note");
    });
  });
});

test("run uniqueness on (assignment_id, trigger_event_id) is enforced", () => {
  withTempStore((store) => {
    const base = {
      id: "R-1" as never,
      assignment_id: assignment().id,
      trigger_event_id: "01J0000000000000000000000A" as never,
      kind: "initial" as const,
      status: "queued" as const,
      role_version: 1,
      model: "fictional-model",
      agent_cli_version: "0.0.1",
      outcome: null,
      summary: "",
    };

    store.uow.run((tx) => {
      tx.assignments.put(project_id, assignment());
      tx.runs.put(project_id, base);
    });

    expect(() =>
      store.uow.run((tx) => {
        // Same assignment and trigger event: a second run must not exist.
        tx.runs.put(project_id, { ...base, id: "R-2" as never });
      }),
    ).toThrow(/UNIQUE/i);
  });
});
