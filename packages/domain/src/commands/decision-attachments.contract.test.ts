import { describe, expect, test } from "vitest";
import type { Attachment } from "../entities.js";
import type { AttachmentId } from "../ids.js";
import {
  MAX_DECISION_ATTACHMENTS,
  type RequestDecisionParams,
  requestDecision,
} from "../index.js";
import { actor, apply, fixture, id, ports, value } from "./test-fixtures.js";

const TEST_PLAIN_SUMMARY = {
  changed: "测试用的改动说明",
  impact: "测试用的影响说明",
  risk: "无",
};

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
  plain_summary: TEST_PLAIN_SUMMARY,
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

describe("C-809: attachments the context names are attached", () => {
  const raise = (extra: Partial<RequestDecisionParams>, s = state()) =>
    value(requestDecision(s, office, { ...params, ...extra }, ports())).data;

  test("an own-card number in the context is attached after the explicit ones", () => {
    const q = raise({
      context: "比例见 attachment-1，另一张 attachment-2",
      attachment_ids: ["attachment-2"],
    });
    expect(q.attachment_ids).toEqual(["attachment-2", "attachment-1"]);
    expect(q).not.toHaveProperty("attachments_omitted");
  });

  test("another card's attachment stays text unless that card is affected", () => {
    const q = raise({ context: "参考 attachment-3 和 attachment-1" });
    expect(q.attachment_ids).toEqual(["attachment-1"]);
    expect(q).not.toHaveProperty("attachments_omitted");
    const affected = raise({
      context: "参考 attachment-3",
      affected_cards: [id("card", 2)],
    });
    expect(affected.attachment_ids).toEqual(["attachment-3"]);
  });

  test("missing, expired and code-quoted numbers are ignored", () => {
    const initial = state();
    const s = {
      ...initial,
      attachments: initial.attachments.map((a) =>
        a.id === "attachment-10"
          ? {
              ...a,
              streamed_artifact: {
                blob_id: "473bd8c2-5552-44a5-ad33-8b5492ee15b3",
                run_id: "R-1",
                created_at: "2026-11-27T00:00:00.000Z",
                expired: { at: "2026-11-27T01:00:00.000Z", reason: "age" },
              },
            }
          : a,
      ) as Attachment[],
    };
    const q = raise(
      { context: "attachment-999、attachment-10，命令 `attachment-11`" },
      s,
    );
    expect(q).not.toHaveProperty("attachment_ids");
    expect(q).not.toHaveProperty("attachments_omitted");
  });

  test("past the limit the rest is counted, not attached and not refused", () => {
    const own = Array.from(
      { length: MAX_DECISION_ATTACHMENTS },
      (_, i) => `attachment-${10 + i}`,
    );
    const q = raise({ context: `截图：attachment-1 ${own.join(" ")}` });
    expect(q.attachment_ids).toEqual(
      ["attachment-1", ...own].slice(0, MAX_DECISION_ATTACHMENTS),
    );
    expect(q.attachments_omitted).toBe(1);
    const explicit = raise({
      context: `截图：attachment-1 ${own.join(" ")}`,
      attachment_ids: ["attachment-2", "attachment-10"],
    });
    expect(explicit.attachment_ids).toEqual([
      "attachment-2",
      "attachment-10",
      "attachment-1",
      "attachment-11",
      "attachment-12",
      "attachment-13",
    ]);
    // attachment-14 and attachment-15 did not fit.
    expect(explicit.attachments_omitted).toBe(2);
    const full = raise({
      context: "再看 attachment-1",
      attachment_ids: own as AttachmentId[],
    });
    expect(full.attachment_ids).toEqual(own);
    expect(full.attachments_omitted).toBe(1);
  });
});
