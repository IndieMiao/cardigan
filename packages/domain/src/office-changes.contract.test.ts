import { describe, expect, test } from "vitest";
import type { Assignment, Cursor, Event } from "./entities.js";
import type { CardId, ProjectId } from "./ids.js";
import {
  DEFAULT_OFFICE_DIGEST_LIMIT,
  OFFICE_ALERT_EVENT_TYPES,
  OFFICE_DIGEST_EVENT_TYPES,
  officeAlertRecipient,
  officeChangeTier,
  officeDigest,
  officeDigestSince,
  officeOnDuty,
} from "./index.js";

const P = "p-office" as ProjectId;
const OTHER = "p-other" as ProjectId;
const T0 = "2026-11-20T00:00:00.000Z";

const assignment = (
  id: string,
  fields: Record<string, unknown> = {},
): Assignment =>
  ({
    id,
    scope: "standing",
    role_id: "pm",
    role_version: 1,
    status: "active",
    created_at: T0,
    ...fields,
  }) as unknown as Assignment;

const office = assignment("A-10", { standing_mode: "office" });
const ops = assignment("A-11", { standing_mode: "ops" });
const coder = assignment("A-1", {
  scope: "work_item",
  role_id: "coder",
  work_item_id: "W-1",
});

let nextId = 0;
const event = (
  type: string,
  fields: {
    card?: string | null;
    seq?: number;
    at?: string;
    project?: ProjectId;
    actor?: string;
    payload?: Record<string, unknown>;
  } = {},
): Event =>
  ({
    id: `E-${++nextId}`,
    ...(fields.card === null ? {} : { card_id: fields.card ?? "C-1" }),
    seq: fields.seq ?? 1,
    type,
    actor: fields.actor
      ? {
          kind: "assignment",
          project_id: fields.project ?? P,
          assignment_id: fields.actor,
          role_id: "pm",
          role_version: 1,
        }
      : { kind: "system", project_id: fields.project ?? P },
    payload: fields.payload ?? {},
    created_at: fields.at ?? "2026-11-21T00:00:00.000Z",
  }) as unknown as Event;

const ALERTS = [
  "human_action_requested",
  "blocker_reported",
  "run_inactive",
  "merge_conflicted",
  "decision_requested",
] as const;

describe("C-722 change tiers", () => {
  test("the five exception/pending types alert; routine progress is digest only", () => {
    expect([...OFFICE_ALERT_EVENT_TYPES].sort()).toEqual([...ALERTS].sort());
    for (const type of ALERTS) expect(officeChangeTier(type)).toBe("alert");
    for (const type of [
      "card_merged",
      "delivery_submitted",
      "review_submitted",
      "card_updated",
      "host_deployment_recorded",
    ])
      expect(officeChangeTier(type)).toBe("digest");
    for (const type of OFFICE_DIGEST_EVENT_TYPES)
      expect(OFFICE_ALERT_EVENT_TYPES.has(type)).toBe(false);
    expect(officeChangeTier("comment_posted")).toBeUndefined();
    expect(officeChangeTier("run_started")).toBeUndefined();
  });
});

describe("C-722 office alert recipient", () => {
  test.each(ALERTS)("%s reaches the project's Office on duty", (type) => {
    const e = event(type, { payload: { assignment_id: coder.id } });
    expect(officeAlertRecipient(P, e, [coder, ops, office])).toBe(office);
  });

  test.each([
    ["suspended", { status: "suspended" }],
    ["released", { status: "released" }],
    ["ops mode", { standing_mode: "ops" }],
    ["legacy row without standing_mode", { standing_mode: undefined }],
    ["work-item pm", { scope: "work_item", work_item_id: "W-9" }],
  ])("an Office that is %s receives nothing and nothing throws", (_, f) => {
    const off = assignment("A-10", { standing_mode: "office", ...f });
    expect(officeOnDuty([coder, ops, off])).toBeUndefined();
    for (const type of ALERTS)
      expect(
        officeAlertRecipient(P, event(type), [coder, ops, off]),
      ).toBeUndefined();
  });

  test("no Office at all: nothing, no error", () => {
    for (const type of ALERTS)
      expect(officeAlertRecipient(P, event(type), [])).toBeUndefined();
  });

  test("routine and unrelated events never alert", () => {
    for (const type of [...OFFICE_DIGEST_EVENT_TYPES, "comment_posted"])
      expect(
        officeAlertRecipient(P, event(type), [coder, office]),
      ).toBeUndefined();
  });

  test("another project's event never reaches this project's Office", () => {
    for (const type of ALERTS)
      expect(
        officeAlertRecipient(P, event(type, { project: OTHER }), [office]),
      ).toBeUndefined();
  });

  test("the Office is not told about its own actions or its own inactivity", () => {
    expect(
      officeAlertRecipient(
        P,
        event("decision_requested", { actor: office.id }),
        [office],
      ),
    ).toBeUndefined();
    expect(
      officeAlertRecipient(
        P,
        event("run_inactive", { payload: { assignment_id: office.id } }),
        [office],
      ),
    ).toBeUndefined();
    // Ops' own inactivity still reaches the Office.
    expect(
      officeAlertRecipient(
        P,
        event("run_inactive", {
          card: null,
          payload: { assignment_id: ops.id },
        }),
        [ops, office],
      ),
    ).toBe(office);
  });
});

describe("C-722 office digest", () => {
  test("the watermark is the Office's project-stream ACK, else its creation", () => {
    const project = [
      event("host_deployment_recorded", {
        card: null,
        seq: 1,
        at: "2026-11-19T00:00:00.000Z",
      }),
      event("cross_card_read", {
        card: null,
        seq: 2,
        at: "2026-11-22T00:00:00.000Z",
      }),
    ];
    expect(officeDigestSince(office, project, 0)).toBe(T0);
    expect(officeDigestSince(office, project, 2)).toBe(
      "2026-11-22T00:00:00.000Z",
    );
    // An ACK older than the Office itself does not widen the window.
    expect(officeDigestSince(office, project, 1)).toBe(T0);
    expect(officeDigestSince(office, [], 7)).toBe(T0);
  });

  test("routine card progress since the watermark, minus what the Office acknowledged", () => {
    const since = "2026-11-21T00:00:00.000Z";
    const events = [
      event("delivery_submitted", {
        card: "C-1",
        seq: 3,
        at: "2026-11-21T01:00:00.000Z",
        payload: { delivery_id: "D-1", work_item_id: "W-1", body: "long" },
      }),
      event("review_submitted", {
        card: "C-1",
        seq: 4,
        at: "2026-11-21T02:00:00.000Z",
        payload: { review_id: "V-1", verdict: "pass" },
      }),
      event("card_merged", {
        card: "C-2",
        seq: 9,
        at: "2026-11-21T03:00:00.000Z",
      }),
      // Already acknowledged on C-2's own stream.
      event("card_updated", {
        card: "C-2",
        seq: 8,
        at: "2026-11-21T02:30:00.000Z",
        payload: { status: "todo" },
      }),
      // Exactly on the watermark: kept (repeat rather than lose).
      event("card_created", { card: "C-3", seq: 1, at: since }),
      // Before the watermark.
      event("card_merged", {
        card: "C-4",
        seq: 5,
        at: "2026-11-20T12:00:00.000Z",
      }),
      // Not a digest type (alerts ring instead).
      event("decision_requested", {
        card: "C-1",
        seq: 5,
        at: "2026-11-21T04:00:00.000Z",
      }),
      // Project-level events already come in the same get_updates read.
      event("host_deployment_recorded", {
        card: null,
        seq: 3,
        at: "2026-11-21T04:00:00.000Z",
      }),
      // Another project's event.
      event("card_merged", {
        card: "C-1",
        seq: 6,
        project: OTHER,
        at: "2026-11-21T05:00:00.000Z",
      }),
      // The Office's own action.
      event("card_created", {
        card: "C-5",
        seq: 1,
        actor: office.id,
        at: "2026-11-21T05:00:00.000Z",
      }),
    ];
    const cursors: Cursor[] = [
      { assignment_id: office.id, card_id: "C-2" as CardId, acked_seq: 8 },
      // Somebody else's cursor does not hide anything from the Office.
      { assignment_id: ops.id, card_id: "C-1" as CardId, acked_seq: 99 },
    ];
    const digest = officeDigest({
      project_id: P,
      office,
      events,
      since,
      cursors,
      cards: [
        { id: "C-1" as CardId, title: "First" },
        { id: "C-2" as CardId, title: "Second" },
      ],
    });
    expect(digest).toEqual({
      since,
      omitted: 0,
      entries: [
        {
          card_id: "C-2",
          card_title: "Second",
          seq: 9,
          type: "card_merged",
          created_at: "2026-11-21T03:00:00.000Z",
        },
        {
          card_id: "C-1",
          card_title: "First",
          seq: 4,
          type: "review_submitted",
          created_at: "2026-11-21T02:00:00.000Z",
          detail: { review_id: "V-1", verdict: "pass" },
        },
        {
          card_id: "C-1",
          card_title: "First",
          seq: 3,
          type: "delivery_submitted",
          created_at: "2026-11-21T01:00:00.000Z",
          detail: { delivery_id: "D-1", work_item_id: "W-1" },
        },
        { card_id: "C-3", seq: 1, type: "card_created", created_at: since },
      ],
    });
  });

  test("beyond the limit the newest entries are kept and the rest counted", () => {
    const events = Array.from(
      { length: DEFAULT_OFFICE_DIGEST_LIMIT + 3 },
      (_, i) =>
        event("card_merged", {
          card: `C-${i + 1}`,
          seq: 1,
          at: new Date(
            Date.parse("2026-11-21T00:00:00.000Z") + i * 1000,
          ).toISOString(),
        }),
    );
    const digest = officeDigest({
      project_id: P,
      office,
      events,
      since: T0,
      cursors: [],
      cards: [],
    });
    expect(digest.entries).toHaveLength(DEFAULT_OFFICE_DIGEST_LIMIT);
    expect(digest.omitted).toBe(3);
    expect(digest.entries[0]?.card_id).toBe(
      `C-${DEFAULT_OFFICE_DIGEST_LIMIT + 3}`,
    );
    expect(
      officeDigest({
        project_id: P,
        office,
        events,
        since: T0,
        cursors: [],
        cards: [],
        limit: 2,
      }).omitted,
    ).toBe(DEFAULT_OFFICE_DIGEST_LIMIT + 1);
  });
});
