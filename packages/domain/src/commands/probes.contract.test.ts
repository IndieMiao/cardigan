import { expect, test } from "vitest";
import type { Actor, Event } from "../entities.js";
import { authorizeProbe, hasProbeEvidence } from "../probes.js";
import {
  builtinCardTemplatesForFlow,
  integrationCardTemplate,
} from "../templates.js";
import type { CommandState } from "./core.js";
import { prepareDelivery, submitDelivery, submitReview } from "./delivery.js";
import { systemCompleteCard } from "./system-completion.js";
import {
  actor,
  apply,
  fixture,
  id,
  ports,
  subject,
  value,
} from "./test-fixtures.js";

const state = (): CommandState => {
  const s = fixture();
  return {
    ...s,
    cards: s.cards.map((c) => ({
      ...c,
      template: "integration",
      template_version: 1,
      flow_version: 5,
    })),
    assignments: s.assignments.map((a) =>
      a.id === id("assignment", 1)
        ? { ...a, branch: "agent/probe", worktree_path: "/synthetic/task" }
        : a,
    ),
    work_items: s.work_items.filter((w) => w.id !== id("work_item", 3)),
  };
};
const evidence = (): Event => ({
  id: ports().ids.nextEventId(),
  seq: 1,
  type: "probe_evidence",
  card_id: id("card", 1),
  actor: { kind: "system", project_id: "fixture-project" },
  created_at: "2026-01-01T00:00:00Z",
  payload: {
    work_item_id: id("work_item", 1),
    head_sha: subject.value,
    tested_sha: "b".repeat(40),
    attachment_id: "evidence-1",
    source: "live",
    result: "passed",
    cleanup: "complete",
  },
});

test("only current producers with explicit token and fixed role permission can use probes", () => {
  const s = state();
  expect(authorizeProbe(s, actor()).ok).toBe(true);
  for (const a of [
    actor(2, "reviewer"),
    actor(4, "pm"),
    { kind: "system", project_id: s.project_id },
    { ...actor(), allowed_tools: [] },
  ] as Actor[])
    expect(authorizeProbe(s, a).ok).toBe(false);
  expect(
    authorizeProbe(
      {
        ...s,
        assignments: s.assignments.map((a) => ({
          ...a,
          status: "released" as const,
        })),
      },
      actor(),
    ).ok,
  ).toBe(false);
  expect(
    authorizeProbe(
      {
        ...s,
        work_items: s.work_items.map((w) => ({
          ...w,
          assignment_id: id("assignment", 9),
        })),
      },
      actor(),
    ).ok,
  ).toBe(false);
});

test("integration is fixed at version 1 on flow 5; evidence cannot be faked, stale, cross-task or uncleared", () => {
  expect(builtinCardTemplatesForFlow(5)).toContain(integrationCardTemplate);
  expect(builtinCardTemplatesForFlow(4)).not.toContain(integrationCardTemplate);
  const owner = {
    project_id: "fixture-project",
    card_id: id("card", 1),
    work_item_id: id("work_item", 1),
  };
  const check = (event: Event, attachments = ["evidence-1"]) =>
    hasProbeEvidence([event], owner, subject.value, attachments);
  expect(check(evidence())).toBe(true);
  expect(check(evidence(), [])).toBe(false);
  expect(check({ ...evidence(), actor: actor() })).toBe(false);
  expect(check({ ...evidence(), card_id: id("card", 2) })).toBe(false);
  for (const patch of [
    { source: "mock" },
    { head_sha: "c".repeat(40) },
    { work_item_id: id("work_item", 2) },
    { cleanup: "pending" },
    { result: "failed" },
    { tested_sha: "unknown" },
  ])
    expect(
      check({
        ...evidence(),
        payload: { ...(evidence().payload as object), ...patch },
      }),
    ).toBe(false);
});

test("the delivery gate requires the host attachment before Git preparation and cannot be waived by known gaps", async () => {
  const s = state();
  const p = {
    work_item_id: id("work_item", 1),
    kind: "code" as const,
    summary: "Integration",
    subject,
    requested_verifiers: [id("work_item", 2)],
    known_gaps: [{ description: "No real evidence" }],
  };
  const verifier = { verify: async () => ({ ok: true as const, value: [] }) };
  const rejected = await prepareDelivery(s, actor(), p, verifier);
  expect(rejected).toMatchObject({
    ok: false,
    error: { message: expect.stringContaining("真实冒烟附件") },
  });
  const attachment = {
    id: "evidence-1",
    sha256: "e".repeat(64),
    mime: "application/json",
    size: 10,
    card_id: id("card", 1),
    uploaded_by: "system" as const,
    storage_path: "private",
    kind: "evidence" as const,
    attach_to: {
      kind: "timeline_entry" as const,
      id: ports().ids.nextTimelineEntryId(s.project_id, id("card", 1)),
    },
  };
  const accepted = await prepareDelivery(
    { ...s, events: [evidence()], attachments: [attachment] },
    actor(),
    { ...p, attachments: [attachment.id] },
    verifier,
  );
  expect(accepted.ok).toBe(true);
});

test("system completion rechecks real smoke evidence after current code review", async () => {
  const clock = ports();
  let s = state();
  const attachment = {
    id: "evidence-1",
    sha256: "e".repeat(64),
    mime: "application/json",
    size: 10,
    card_id: id("card", 1),
    uploaded_by: "system" as const,
    storage_path: "private",
    kind: "evidence" as const,
    attach_to: {
      kind: "timeline_entry" as const,
      id: clock.ids.nextTimelineEntryId(s.project_id, id("card", 1)),
    },
  };
  s = { ...s, events: [evidence()], attachments: [attachment] };
  const params = {
    work_item_id: id("work_item", 1),
    kind: "code" as const,
    summary: "Integration",
    subject,
    requested_verifiers: [id("work_item", 2)],
    attachments: [attachment.id],
  };
  const receipt = value(
    await prepareDelivery(s, actor(), params, {
      verify: async () => ({ ok: true, value: [] }),
    }),
  );
  const product = value(submitDelivery(s, actor(), params, receipt, clock));
  s = apply(s, product);
  s = apply(
    s,
    value(
      submitReview(
        s,
        actor(2, "reviewer"),
        {
          delivery_id: product.data.id,
          target_sha: subject.value,
          kind: "code",
          issues: [],
        },
        clock,
      ),
    ),
  );
  const system = { kind: "system" as const, project_id: s.project_id };
  expect(
    value(
      systemCompleteCard(
        { ...s, events: s.events.filter((e) => e.type !== "probe_evidence") },
        system,
        { card_id: id("card", 1) },
        clock,
      ),
    ).data,
  ).toBeNull();
  expect(
    value(systemCompleteCard(s, system, { card_id: id("card", 1) }, clock)).data
      ?.kind,
  ).toBe("card_completion");
});
