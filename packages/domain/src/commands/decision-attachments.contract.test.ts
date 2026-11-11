import { expect, test } from "vitest";
import type { Attachment } from "../entities.js";
import {
  MAX_DECISION_ATTACHMENTS,
  type RequestDecisionParams,
  requestDecision,
} from "../index.js";
import { actor, apply, fixture, id, ports, value } from "./test-fixtures.js";

const attachment = (n: number, card: number, mime = "image/png") =>
  ({
    id: `attachment-${n}`,
    sha256: String(n).padStart(64, "0"),
    mime,
    size: 10,
    card_id: id("card", card),
    uploaded_by: "human",
    storage_path: `blobs/${n}`,
    attach_to: { kind: "timeline_entry", id: `${id("card", card)}#1` },
    kind: "evidence",
  }) as Attachment;

const state = () => ({
  ...fixture(),
  attachments: [
    attachment(1, 1),
    attachment(2, 1, "application/pdf"),
    attachment(3, 2),
    ...Array.from({ length: MAX_DECISION_ATTACHMENTS }, (_, i) =>
      attachment(10 + i, 1),
    ),
  ],
});
const office = actor(4, "pm");
const params: RequestDecisionParams = {
  card_id: id("card", 1),
  category: "feature_detail",
  kind: "choose",
  question: "Which layout?",
  context: "See the screenshots",
  options: [
    { key: "a", description: "Left", impact: "Keeps width" },
    { key: "b", description: "Right", impact: "Wider" },
  ],
  recommended: "a",
  affected_cards: [],
  affected_work_items: [],
  blocking: false,
  decider: "human",
};

test("§6 C-95: a decision records referenced card attachments in display order", () => {
  const effect = value(
    requestDecision(
      state(),
      office,
      { ...params, attachment_ids: ["attachment-2", "attachment-1"] },
      ports(),
    ),
  );
  expect(effect.data.attachment_ids).toEqual(["attachment-2", "attachment-1"]);
  const next = apply(state(), effect);
  expect(
    next.decisions.find((q) => q.id === effect.data.id)?.attachment_ids,
  ).toEqual(["attachment-2", "attachment-1"]);
});

test("§6 C-95: attachments of an affected card are allowed", () => {
  const effect = value(
    requestDecision(
      state(),
      office,
      {
        ...params,
        affected_cards: [id("card", 2)],
        attachment_ids: ["attachment-3"],
      },
      ports(),
    ),
  );
  expect(effect.data.attachment_ids).toEqual(["attachment-3"]);
});

test("§6 C-95: decisions without attachments keep their previous shape", () => {
  for (const attachment_ids of [undefined, []]) {
    const effect = value(
      requestDecision(
        state(),
        office,
        { ...params, ...(attachment_ids ? { attachment_ids } : {}) },
        ports(),
      ),
    );
    expect(effect.data).not.toHaveProperty("attachment_ids");
  }
});

test.each([
  ["an unrelated card", ["attachment-3"], "validation_failed"],
  ["another project or a missing attachment", ["attachment-999"], "not_found"],
  [
    "a mix of valid and unrelated",
    ["attachment-1", "attachment-3"],
    "validation_failed",
  ],
  ["duplicates", ["attachment-1", "attachment-1"], "validation_failed"],
  [
    "more than the limit",
    [
      "attachment-1",
      ...Array.from(
        { length: MAX_DECISION_ATTACHMENTS },
        (_, i) => `attachment-${10 + i}`,
      ),
    ],
    "validation_failed",
  ],
] as const)(
  "§6 C-95: references to %s are rejected without any write",
  (_label, attachment_ids, code) => {
    const initial = state();
    const result = requestDecision(
      initial,
      actor(),
      { ...params, blocking: true, attachment_ids },
      ports(),
    );
    expect(result).toMatchObject({ ok: false, error: { code } });
    // Blocking requests pause work and end Runs; a rejection must leave both untouched.
    expect(result).not.toHaveProperty("value");
  },
);

test("§6 C-95: exactly the limit is accepted", () => {
  const ids = Array.from(
    { length: MAX_DECISION_ATTACHMENTS },
    (_, i) => `attachment-${10 + i}`,
  );
  const effect = value(
    requestDecision(
      state(),
      office,
      { ...params, attachment_ids: ids },
      ports(),
    ),
  );
  expect(effect.data.attachment_ids).toEqual(ids);
});
