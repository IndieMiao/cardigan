import { expect, test } from "vitest";
import { prepareAttachment, uploadAttachment } from "./attachments.js";
import { postComment } from "./coordination.js";
import { actor, apply, fixture, id, ports, value } from "./test-fixtures.js";

async function setup() {
  const io = ports();
  const posted = value(
    postComment(
      fixture(),
      actor(),
      { card_id: id("card", 1), body: "Evidence" },
      io,
    ),
  );
  if (!posted.data) throw new Error("Missing comment");
  const state = apply(fixture(), posted);
  const receipt = value(
    await prepareAttachment("a".repeat(64), new Uint8Array([1]), {
      put: async (sha256) => ({ storage_path: `attachments/${sha256}` }),
      get: async () => undefined,
    }),
  );
  const params = {
    card_id: id("card", 1),
    mime: "image/png",
    kind: "evidence" as const,
    attach_to: { kind: "timeline_entry" as const, id: posted.data.id },
  };
  return (
    metadata: Partial<
      Pick<Parameters<typeof uploadAttachment>[2], "original_filename" | "note">
    > = {},
  ) =>
    uploadAttachment(state, actor(), { ...params, ...metadata }, receipt, io);
}

test.each([
  "截图.png",
  "/tmp/../截图.png",
  "C:\\fakepath\\截图.png",
  "folder\\nested/截图.png",
])(
  "invariant 11: attachment filenames are display-only basenames (%s)",
  async (original_filename) => {
    const upload = await setup();
    const effect = value(upload({ original_filename, note: "修复后的截图" }));
    expect(effect.data).toMatchObject({
      original_filename: "截图.png",
      note: "修复后的截图",
      storage_path: `attachments/${"a".repeat(64)}`,
      sha256: "a".repeat(64),
    });
    expect(
      effect.changes.find((change) => change.collection === "attachments")
        ?.entity,
    ).toEqual(effect.data);
  },
);

test("legacy uploads omit display metadata; Unicode limits include exactly 200 code points", async () => {
  const upload = await setup();
  expect(value(upload()).data).not.toHaveProperty("original_filename");
  expect(value(upload()).data).not.toHaveProperty("note");
  const original_filename = `${"图".repeat(196)}.png`,
    note = "😀".repeat(200);
  expect(
    value(
      upload({
        original_filename: `${"directory/".repeat(30)}${original_filename}`,
        note,
      }),
    ).data,
  ).toMatchObject({ original_filename, note });
});

test.each(["original_filename", "note"] as const)(
  "invariant 11: %s rejects oversized, blank and control-character metadata without effects",
  async (field) => {
    const upload = await setup();
    for (const invalid of [
      "a".repeat(201),
      "😀".repeat(201),
      "",
      " ",
      "before\nafter",
      "x\r",
      "x\t",
      "x\0",
      "x\u007f",
      "x\u0085",
      "x\u202e",
      "x\u2028",
      "x\u2029",
    ]) {
      expect(upload({ [field]: invalid })).toMatchObject({
        ok: false,
        error: { code: "validation_failed" },
      });
    }
    if (field === "original_filename") {
      for (const invalid of ["dir/", "dir\\", "bad\n/path.png"]) {
        expect(upload({ original_filename: invalid })).toMatchObject({
          ok: false,
          error: { code: "validation_failed" },
        });
      }
    }
  },
);
