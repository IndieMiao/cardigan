import { expect, test } from "vitest";
import type { Actor, Card, Decision, Event } from "../entities.js";
import { parseEventId } from "../ids.js";
import {
  RELEASE_NOTE_MAX_LENGTH,
  RELEASE_NOTE_RECENT_CARDS,
  releaseMergedCards,
  releaseNoteEntries,
  releaseNoteHistory,
} from "../release-notes.js";
import type { CommandState } from "./core.js";
import { listReleaseNotes, writeReleaseNote } from "./release-notes.js";
import {
  actor,
  apply,
  card,
  fixture,
  human,
  id,
  ports,
  value,
} from "./test-fixtures.js";

const office = actor(4, "pm");
let n = 1000;
const event = (
  type: string,
  at: string,
  payload: Record<string, unknown>,
  card_id?: Card["id"],
): Event => ({
  id: value(parseEventId(String(++n).padStart(26, "0"))),
  ...(card_id ? { card_id } : {}),
  seq: n,
  type,
  actor: { kind: "system", project_id: human.project_id },
  payload: payload as Event["payload"],
  created_at: at,
});
const verified = (version: string, decision: number, at: string, code = 1) =>
  event(
    "artifact_publication_verified",
    at,
    {
      attachment_id: "attachment-1",
      decision_id: id("decision", decision),
      version,
      versionCode: code,
      result: "https://example.invalid/app.apk · 1 bytes · SHA-256 x",
    },
    id("card", 1),
  );
const merged = (cardNumber: number, at: string) =>
  event("card_merged", at, {}, id("card", cardNumber));
const publishDecision = (n: number, category = "publish") =>
  ({ id: id("decision", n), category }) as unknown as Decision;
const titled = (n: number): Card => ({ ...card(n), title: `Card ${n}` });

function state(events: Event[] = [], cards = 3): CommandState {
  return {
    ...fixture(),
    cards: Array.from({ length: cards }, (_, i) => titled(i + 1)),
    decisions: [
      publishDecision(1),
      publishDecision(2),
      publishDecision(9, "general"),
    ],
    events,
  };
}
const write = (
  s: CommandState,
  input: Parameters<typeof writeReleaseNote>[2],
  who: Actor = office,
  via?: "publish_artifact",
) => writeReleaseNote(s, who, input, ports(), via);

test("one note per project and version: a second write revises it and keeps every revision", () => {
  let s = state([verified("1.0.0", 1, "2026-02-01T00:00:00.000Z")]);
  const first = write(s, { version: "1.0.0", body: "新增登录页" });
  expect(first.ok).toBe(true);
  if (!first.ok) return;
  expect(first.value.data.note).toMatchObject({
    version: "1.0.0",
    version_code: 1,
    decision_id: id("decision", 1),
    body: "新增登录页",
    revision: 1,
    author: `assignment:${id("assignment", 4)}`,
  });
  // Project stream only: no card, timeline, entity or Needs You change.
  expect(first.value.events.map((e) => [e.type, e.card_id])).toEqual([
    ["release_note_written", undefined],
  ]);
  expect(first.value.changes).toEqual([]);
  expect(first.value.timeline).toEqual([]);
  s = apply(s, first.value);
  const second = value(
    write(
      s,
      { version: "1.0.0", body: "新增登录页和设置页", base_revision: 1 },
      human,
    ),
  );
  s = apply(s, second);
  expect(second.data.note).toMatchObject({
    revision: 2,
    body: "新增登录页和设置页",
    author: "human",
    created_by: `assignment:${id("assignment", 4)}`,
    decision_id: id("decision", 1),
  });
  expect(releaseNoteEntries(s.events).map((e) => e.version)).toEqual(["1.0.0"]);
  expect(
    releaseNoteHistory(s.events, "1.0.0").map((r) => [
      r.revision,
      r.body,
      r.author,
      r.source,
    ]),
  ).toEqual([
    [
      1,
      "新增登录页",
      `assignment:${id("assignment", 4)}`,
      "write_release_note",
    ],
    [2, "新增登录页和设置页", "human", "workbench"],
  ]);
  // The same content again is not a new revision.
  const same = value(
    write(s, { version: "1.0.0", body: "新增登录页和设置页" }),
  );
  expect(same.data.changed).toBe(false);
  expect(same.events).toEqual([]);
});

test("a stale base revision is rejected instead of overwriting", () => {
  let s = state();
  s = apply(s, value(write(s, { version: "2.0", body: "a" })));
  const stale = write(s, { version: "2.0", body: "b", base_revision: 0 });
  expect(stale.ok).toBe(false);
  if (!stale.ok) expect(stale.error.code).toBe("stale_target");
  const fresh = write(state(), { version: "2.0", body: "b", base_revision: 1 });
  expect(fresh.ok).toBe(false);
});

test("the body is required and has a length ceiling; the version keeps the publish format", () => {
  const s = state();
  for (const body of [
    "",
    "   \n",
    "x".repeat(RELEASE_NOTE_MAX_LENGTH + 1),
    "a\u0000b",
  ]) {
    const result = write(s, { version: "1.0.0", body });
    expect(result.ok, JSON.stringify(body.slice(0, 8))).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("validation_failed");
  }
  expect(
    write(s, { version: "1.0.0", body: "字".repeat(RELEASE_NOTE_MAX_LENGTH) })
      .ok,
  ).toBe(true);
  expect(write(s, { version: "1.0.0", body: "多行\n\t内容" }).ok).toBe(true);
  for (const version of ["", "../x", "1 0", "-1"])
    expect(write(s, { version, body: "x" }).ok).toBe(false);
});

test("only the standing PM and the human write or list notes", () => {
  const s = state();
  for (const who of [actor(1, "coder"), actor(3, "pm"), actor(2, "reviewer")]) {
    expect(write(s, { version: "1.0.0", body: "x" }, who).ok).toBe(false);
    expect(listReleaseNotes(s, who).ok).toBe(false);
  }
  expect(write(s, { version: "1.0.0", body: "x" }, human).ok).toBe(true);
  expect(listReleaseNotes(s, office).ok).toBe(true);
  expect(listReleaseNotes(s, human).ok).toBe(true);
});

test("publish_artifact may only write the note of the version it has just verified", () => {
  const s = state([verified("1.0.0", 1, "2026-02-01T00:00:00.000Z", 7)]);
  const ok = write(
    s,
    { version: "1.0.0", body: "x", decision_id: id("decision", 1) },
    office,
    "publish_artifact",
  );
  expect(ok.ok).toBe(true);
  if (ok.ok) expect(ok.value.data.note).toMatchObject({ version_code: 7 });
  for (const input of [
    { version: "1.0.1", body: "x", decision_id: id("decision", 1) },
    { version: "1.0.0", body: "x", decision_id: id("decision", 2) },
  ])
    expect(write(s, input, office, "publish_artifact").ok).toBe(false);
  expect(
    write(
      s,
      { version: "1.0.0", body: "x", decision_id: id("decision", 1) },
      human,
      "publish_artifact",
    ).ok,
  ).toBe(false);
});

test("the publication decision is inferred, and an explicit one must be a matching publish decision", () => {
  const s = state([verified("1.0.0", 1, "2026-02-01T00:00:00.000Z")]);
  expect(
    write(s, { version: "1.0.0", body: "x", decision_id: id("decision", 2) })
      .ok,
  ).toBe(false);
  expect(
    write(s, { version: "1.0.0", body: "x", decision_id: id("decision", 9) })
      .ok,
  ).toBe(false);
  expect(
    write(s, { version: "1.0.0", body: "x", decision_id: id("decision", 404) })
      .ok,
  ).toBe(false);
  expect(write(s, { version: "1.0.0", body: "x", version_code: 2 }).ok).toBe(
    false,
  );
  // Unpublished: links and version code are taken as given.
  const early = value(
    write(s, {
      version: "1.1.0",
      body: "x",
      decision_id: id("decision", 2),
      version_code: 5,
    }),
  );
  expect(early.data.note).toMatchObject({
    decision_id: id("decision", 2),
    version_code: 5,
  });
});

test("merged cards: since the previous successful publication up to this one, else the most recent", () => {
  const events = [
    merged(1, "2026-01-10T00:00:00.000Z"),
    verified("1.0.0", 1, "2026-02-01T00:00:00.000Z"),
    merged(2, "2026-02-02T00:00:00.000Z"),
    merged(3, "2026-02-03T00:00:00.000Z"),
    verified("1.1.0", 2, "2026-03-01T00:00:00.000Z"),
    merged(1, "2026-03-02T00:00:00.000Z"),
  ];
  const s = state(events);
  const release = releaseMergedCards(s, "1.1.0");
  expect(release).toMatchObject({
    basis: "since_last_publication",
    since: { version: "1.0.0", published_at: "2026-02-01T00:00:00.000Z" },
    until: "2026-03-01T00:00:00.000Z",
    omitted: 0,
  });
  expect(release.cards.map((c) => [c.id, c.title])).toEqual([
    [id("card", 3), "Card 3"],
    [id("card", 2), "Card 2"],
  ]);
  // The next, unpublished version: everything merged after 1.1.0.
  expect(releaseMergedCards(s, "1.2.0").cards.map((c) => c.id)).toEqual([
    id("card", 1),
  ]);
  // No earlier publication: the most recent merges, said so.
  const first = releaseMergedCards(s, "1.0.0");
  expect(first.basis).toBe("recent");
  expect(first.since).toBeNull();
  expect(first.note).toContain("没有更早的成功发布记录");
  expect(first.cards.map((c) => c.id)).toEqual([id("card", 1)]);
  const many = state(
    Array.from({ length: RELEASE_NOTE_RECENT_CARDS + 5 }, (_, i) =>
      merged(i + 1, `2026-01-${String(i + 1).padStart(2, "0")}T00:00:00.000Z`),
    ),
    RELEASE_NOTE_RECENT_CARDS + 5,
  );
  const recent = releaseMergedCards(many, "0.1.0");
  expect(recent.cards).toHaveLength(RELEASE_NOTE_RECENT_CARDS);
  expect(recent.cards[0]?.id).toBe(id("card", RELEASE_NOTE_RECENT_CARDS + 5));
  // The write result carries the same reference list.
  const written = value(write(s, { version: "1.1.0", body: "x" }));
  expect(written.data.merged_cards).toEqual(release);
});

test("the list has published versions without notes and is newest first", () => {
  let s = state([
    verified("1.0.0", 1, "2026-02-01T00:00:00.000Z", 1),
    verified("1.1.0", 2, "2026-03-01T00:00:00.000Z", 2),
  ]);
  s = apply(s, value(write(s, { version: "1.0.0", body: "旧版本说明" })));
  s = apply(
    s,
    value(write(s, { version: "1.2.0", body: "下一版草稿", version_code: 3 })),
  );
  const listing = value(listReleaseNotes(s, office)).data;
  expect("entries" in listing).toBe(true);
  if (!("entries" in listing)) return;
  expect(
    listing.entries.map((e) => [
      e.version,
      e.published_at,
      e.note?.body ?? null,
    ]),
  ).toEqual([
    ["1.1.0", "2026-03-01T00:00:00.000Z", null],
    ["1.0.0", "2026-02-01T00:00:00.000Z", "旧版本说明"],
    // Unpublished notes sort by when they were written (the fixture clock).
    ["1.2.0", null, "下一版草稿"],
  ]);
  const one = value(listReleaseNotes(s, office, { version: "1.0.0" })).data;
  expect(one).toMatchObject({
    entry: { version: "1.0.0" },
    history: [{ revision: 1, body: "旧版本说明" }],
    merged_cards: { basis: "recent" },
  });
});
