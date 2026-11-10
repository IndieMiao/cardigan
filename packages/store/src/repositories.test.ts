import { expect, test } from "vitest";
import {
  assignment,
  card,
  project_id,
  withTempStore,
  workItem,
} from "./test-support.js";

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
      expect(tx.cards.get(project_id, card().id)).toEqual(card());
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
