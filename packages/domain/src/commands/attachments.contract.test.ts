import { expect, test } from "vitest";
import {
  artifactUploadRun,
  isVideoMimeType,
  MAX_VIDEO_POSTER_BYTES,
  prepareAttachment,
  prepareStreamedArtifact,
  prepareStreamedAttachment,
  uploadAttachment,
} from "./attachments.js";
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

test("streamed evidence binds its original run and cannot publish after the run has changed", async () => {
  const io = ports(),
    state = fixture();
  const posted = value(
    postComment(
      state,
      actor(),
      { card_id: id("card", 1), body: "Package" },
      io,
    ),
  );
  if (!posted.data) throw Error("Missing entry");
  const current = apply(state, posted),
    target = {
      card_id: id("card", 1),
      mime: "application/octet-stream",
      kind: "evidence" as const,
      attach_to: { kind: "timeline_entry" as const, id: posted.data.id },
    };
  const run = value(artifactUploadRun(current, actor(), target)).data;
  const receipt = await prepareStreamedArtifact(run, async () => ({
    sha256: "a".repeat(64),
    size: 2 ** 31,
    id: "473bd8c2-5552-44a5-ad33-8b5492ee15b3",
  }));
  expect(
    value(uploadAttachment(current, actor(), target, receipt, io)).data,
  ).toMatchObject({
    size: 2 ** 31,
    streamed_artifact: { run_id: run },
    attach_to: target.attach_to,
  });
  expect(
    uploadAttachment({ ...current, runs: [] }, actor(), target, receipt, io).ok,
  ).toBe(false);
  expect(
    artifactUploadRun(current, actor(), { ...target, card_id: id("card", 2) })
      .ok,
  ).toBe(false);
});

test("C-683: a streamed file receipt records the adapter's size and blob, never a run", async () => {
  const io = ports();
  const posted = value(
    postComment(
      fixture(),
      actor(),
      { card_id: id("card", 1), body: "Video" },
      io,
    ),
  );
  if (!posted.data) throw new Error("Missing comment");
  const state = apply(fixture(), posted);
  let puts = 0;
  const receipt = value(
    await prepareStreamedAttachment(
      "b".repeat(64),
      600 * 1024 * 1024,
      async () => {
        puts += 1;
        return { storage_path: `attachments/${"b".repeat(64)}` };
      },
    ),
  );
  expect(puts).toBe(1);
  const effect = value(
    uploadAttachment(
      state,
      actor(),
      {
        card_id: id("card", 1),
        mime: "video/mp4",
        kind: "evidence",
        attach_to: { kind: "timeline_entry", id: posted.data.id },
      },
      receipt,
      io,
    ),
  );
  expect(effect.data).toMatchObject({
    sha256: "b".repeat(64),
    size: 600 * 1024 * 1024,
    storage_path: `attachments/${"b".repeat(64)}`,
    mime: "video/mp4",
  });
  expect(effect.data).not.toHaveProperty("streamed_artifact");
  // A malformed digest or size never reaches the store; a failing store is a
  // validation failure, not a receipt.
  expect(
    (
      await prepareStreamedAttachment("x", 1, async () => ({
        storage_path: "",
      }))
    ).ok,
  ).toBe(false);
  expect(
    (
      await prepareStreamedAttachment("b".repeat(64), -1, async () => ({
        storage_path: "",
      }))
    ).ok,
  ).toBe(false);
  expect(
    await prepareStreamedAttachment("b".repeat(64), 1, async () => {
      throw new Error("disk full");
    }),
  ).toMatchObject({ ok: false, error: { code: "validation_failed" } });
});

test("C-683: a video record keeps the uploader's measurements and the stored poster; other types refuse them", async () => {
  const io = ports();
  const posted = value(
    postComment(
      fixture(),
      actor(),
      { card_id: id("card", 1), body: "Video" },
      io,
    ),
  );
  if (!posted.data) throw new Error("Missing comment");
  const state = apply(fixture(), posted);
  const store = {
    put: async (sha256: string) => ({ storage_path: `attachments/${sha256}` }),
    get: async () => undefined,
  };
  const receipt = value(
    await prepareAttachment("c".repeat(64), new Uint8Array(10), store),
  );
  const poster = value(
    await prepareAttachment("d".repeat(64), new Uint8Array(2048), store),
  );
  const target = {
    card_id: id("card", 1),
    mime: "video/webm",
    kind: "evidence" as const,
    attach_to: { kind: "timeline_entry" as const, id: posted.data.id },
  };
  const video = {
    duration_seconds: 74.12345,
    width: 1920,
    height: 1080,
    video_codec: "vp9",
    audio_codec: "opus",
  };
  expect(
    value(
      uploadAttachment(
        state,
        actor(),
        { ...target, video },
        receipt,
        io,
        poster,
      ),
    ).data?.video,
  ).toEqual({
    ...video,
    duration_seconds: 74.123,
    poster_sha256: "d".repeat(64),
    poster_size: 2048,
  });
  // Neither metadata nor a poster: no video field (CLI and Agent uploads).
  expect(
    value(uploadAttachment(state, actor(), target, receipt, io)).data,
  ).not.toHaveProperty("video");
  for (const [params, cover] of [
    [{ ...target, mime: "image/png", video }, undefined],
    [{ ...target, mime: "image/png" }, poster],
    [{ ...target, video: { ...video, width: 1.5 } }, undefined],
    [{ ...target, video: { ...video, duration_seconds: -1 } }, undefined],
    [
      { ...target, video: { ...video, duration_seconds: Number.NaN } },
      undefined,
    ],
    [{ ...target, video: { ...video, video_codec: "<script>" } }, undefined],
  ] as const) {
    expect(
      uploadAttachment(state, actor(), params, receipt, io, cover),
    ).toMatchObject({ ok: false, error: { code: "validation_failed" } });
  }
  const huge = value(
    await prepareAttachment(
      "e".repeat(64),
      new Uint8Array(MAX_VIDEO_POSTER_BYTES + 1),
      store,
    ),
  );
  expect(
    uploadAttachment(state, actor(), target, receipt, io, huge),
  ).toMatchObject({ ok: false, error: { code: "validation_failed" } });
  expect(isVideoMimeType("video/x-m4v")).toBe(true);
  expect(isVideoMimeType("video/x-msvideo")).toBe(false);
});
