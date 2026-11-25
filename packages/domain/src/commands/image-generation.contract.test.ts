import { expect, test } from "vitest";
import type { Attachment } from "../entities.js";
import {
  authorizeImageGeneration,
  IMAGE_GENERATION_MAX_REFERENCES,
  imageReferencesOnCard,
} from "../image-generation.js";
import { ROLE_TOOL_ALLOWLISTS } from "../role.js";
import { actor, fixture, id, now } from "./test-fixtures.js";

const att = (n: number) => `AT-${n}` as Attachment["id"];
const image = (
  n: number,
  patch: Partial<Pick<Attachment, "mime" | "card_id">> = {},
): Attachment => ({
  id: att(n),
  sha256: String(n).padStart(64, "0"),
  mime: "image/png",
  size: 10,
  card_id: id("card", 1),
  uploaded_by: "human",
  storage_path: `attachments/${String(n).padStart(64, "0")}`,
  attach_to: { kind: "timeline_entry", id: "C-1#1" as never },
  kind: "evidence",
  ...patch,
});

test("only the active producer of an open card may generate images", () => {
  const s = fixture();
  expect(authorizeImageGeneration(s, actor(1, "coder"))).toEqual({
    ok: true,
    value: {
      project_id: s.project_id,
      card_id: id("card", 1),
      work_item_id: id("work_item", 1),
      assignment_id: id("assignment", 1),
      role_id: "coder",
    },
  });
  // Verifiers, humans and released owners are refused.
  expect(authorizeImageGeneration(s, actor(2, "reviewer")).ok).toBe(false);
  expect(
    authorizeImageGeneration(s, { kind: "human", project_id: s.project_id }).ok,
  ).toBe(false);
  const released = {
    ...s,
    assignments: s.assignments.map((a) =>
      a.id === id("assignment", 1) ? { ...a, status: "released" as const } : a,
    ),
  };
  expect(authorizeImageGeneration(released, actor(1, "coder")).ok).toBe(false);
});

test("a held or closed card refuses image generation", () => {
  const s = fixture();
  const hold = {
    reason: "x",
    resume_condition: "y",
    set_by: "human",
    set_at: now,
  } as const;
  expect(
    authorizeImageGeneration(
      { ...s, cards: s.cards.map((c) => ({ ...c, hold })) },
      actor(),
    ).ok,
  ).toBe(false);
  for (const status of ["done", "cancelled"] as const)
    expect(
      authorizeImageGeneration(
        { ...s, cards: s.cards.map((c) => ({ ...c, status })) },
        actor(),
      ).ok,
    ).toBe(false);
});

test("references must be distinct image attachments of the same card", () => {
  const card = id("card", 1);
  const state = {
    attachments: [
      image(1),
      image(2, { mime: "image/webp" }),
      image(3, { card_id: id("card", 2) }),
      image(4, { mime: "application/json" }),
    ],
  };
  expect(imageReferencesOnCard(state, card, [att(1), att(2)])).toBeUndefined();
  expect(imageReferencesOnCard(state, card, [])).toBeUndefined();
  expect(imageReferencesOnCard(state, card, [att(3)])).toContain(
    "不是本卡的附件",
  );
  expect(imageReferencesOnCard(state, card, [att(9)])).toContain(
    "不是本卡的附件",
  );
  expect(imageReferencesOnCard(state, card, [att(4)])).toContain("不是 PNG");
  expect(imageReferencesOnCard(state, card, [att(1), att(1)])).toBe(
    "参考图不能重复",
  );
  expect(
    imageReferencesOnCard(
      state,
      card,
      Array.from({ length: IMAGE_GENERATION_MAX_REFERENCES + 1 }, (_, n) =>
        att(n + 1),
      ),
    ),
  ).toContain("最多");
});

test("image generation is a producer tool, never a verifier tool", () => {
  expect(ROLE_TOOL_ALLOWLISTS.produce).toContain("generate_image");
  expect(ROLE_TOOL_ALLOWLISTS.verify).not.toContain("generate_image");
  expect(ROLE_TOOL_ALLOWLISTS.standing).not.toContain("generate_image");
});
