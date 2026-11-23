import { expect, test } from "vitest";
import {
  approvedReleaseChain,
  approvesPublication,
  RELEASE_CHAIN_SIGNED,
  releaseChainOf,
  releaseChainSigned,
  releaseChainSmoked,
  releaseChainUrl,
} from "./artifact-publication.js";
import { prepareAttachment, uploadAttachment } from "./commands/attachments.js";
import { postComment } from "./commands/coordination.js";
import type { CommandState } from "./commands/core.js";
import { createCard } from "./commands/pm.js";
import { validateCardTemplate } from "./commands/templates.js";
import {
  actor,
  apply,
  fixture,
  human,
  id,
  now,
  ports,
  role,
  value,
} from "./commands/test-fixtures.js";
import type {
  Attachment,
  Decision,
  Delivery,
  Event,
  WorkItem,
} from "./entities.js";
import { releaseCardTemplate } from "./templates.js";

const project = human.project_id,
  c = id("card", 1),
  commit = "c".repeat(40),
  unsigned = "a".repeat(64),
  signed = "b".repeat(64),
  key = id("decision", 1),
  template = "https://dl.example.invalid/app/test/<version>-<sha12>/app.apk";
const resolution = {
  option: "release_chain",
  rationale: "一次批准整条链",
  via: "needs_you",
  resolved_by: "human",
  via_chain: [],
  raw_quote: "批准",
  at: now,
} as const;
const chain: Decision = {
  id: key,
  key,
  card_id: c,
  category: "publish",
  kind: "approve",
  status: "resolved",
  target: { subject: { kind: "artifact_sha256", value: unsigned } },
  options: [
    {
      key: "release_chain",
      description: `发布链 ${commit} 发布到 ${template}`,
      impact: "入库、送签、签后入库、外发按链自动执行",
    },
    { key: "reject", description: "不发", impact: "停止" },
  ],
  recommended: "release_chain",
  question: "批准发布链？",
  context: "测试站",
  affected_cards: [c],
  affected_work_items: [],
  raised_by: "human",
  decider: "human",
  blocking: false,
  doc_refs: [],
  resolution,
};
const signedApk: Attachment = {
  kind: "artifact",
  basis: key,
  id: "attachment-2",
  card_id: c,
  sha256: signed,
  size: 5,
  storage_path: "",
  mime: "application/vnd.android.package-archive",
  uploaded_by: "human",
  attach_to: {
    kind: "timeline_entry",
    id: ports().ids.nextTimelineEntryId(project, c),
  },
};
const bound = (over: Partial<Event> = {}): Event => ({
  id: ports().ids.nextEventId(),
  seq: 9,
  card_id: c,
  actor: { kind: "system", project_id: project },
  type: RELEASE_CHAIN_SIGNED,
  payload: { decision_id: key, request_id: "f".repeat(32), sha256: signed },
  created_at: now,
  ...over,
});

test("a release chain binds the source commit, unsigned digest and destination template", () => {
  expect(releaseChainOf(chain)).toEqual({
    decision_id: key,
    card_id: c,
    source_commit: commit,
    unsigned_sha256: unsigned,
    url_template: template,
  });
  const description = (d: string) => ({
    ...chain,
    options: [{ key: "release_chain", description: d, impact: "x" }],
  });
  for (const invalid of [
    { ...chain, category: "general" },
    { ...chain, kind: "choose" },
    { ...chain, card_id: undefined },
    { ...chain, target: { subject: { kind: "git_head", value: commit } } },
    description(`发布链 ${commit.slice(1)} 发布到 ${template}`),
    description(`发布链 ${commit} 发布到 http://dl.example.invalid/app.apk`),
    description(`发布链 ${commit} 发布到 ${template} 另加`),
    description(`发布链 ${commit} 发布到 https://x.invalid/<other>/app.apk`),
    {
      ...chain,
      options: [
        ...chain.options,
        { ...chain.options[0], key: "release_chain" },
      ],
    },
  ] as Decision[])
    expect(releaseChainOf(invalid)).toBeUndefined();
  const approved = approvedReleaseChain(project, chain, undefined, []);
  expect(approved && releaseChainUrl(approved, "1.2.0", signed)).toBe(
    `https://dl.example.invalid/app/test/1.2.0-${signed.slice(0, 12)}/app.apk`,
  );
});

test("only a resolved human or delegated chain answer is the chain authority", () => {
  const check = (q: Decision) =>
    approvedReleaseChain(project, q, undefined, []) !== undefined;
  expect(check(chain)).toBe(true);
  for (const invalid of [
    { ...chain, status: "open" },
    { ...chain, superseded_by: id("decision", 2) },
    { ...chain, resolution: { ...resolution, option: "reject" } },
    { ...chain, resolution: { ...resolution, via: "pm_office_chat" } },
    {
      ...chain,
      decider: "role:pm",
      resolution: {
        ...resolution,
        resolved_by: `assignment:${id("assignment", 1)}`,
        via: "delegated",
        proxy_authority: "project:x/decision_delegation/publish/event:none",
      },
    },
  ] as Decision[])
    expect(check(invalid)).toBe(false);
});

test("publication under a chain needs the signed digest bound from a system signing receipt", () => {
  const publish = (events: Event[], a: Attachment = signedApk) =>
    approvesPublication(project, a, chain, undefined, [], events);
  expect(publish([bound()])).toBe(true);
  expect(publish([])).toBe(false);
  expect(publish([bound({ actor: { ...human } as Event["actor"] })])).toBe(
    false,
  );
  expect(
    publish([
      bound({
        payload: {
          decision_id: id("decision", 3),
          request_id: "f".repeat(32),
          sha256: signed,
        },
      }),
    ]),
  ).toBe(false);
  expect(publish([bound()], { ...signedApk, sha256: unsigned })).toBe(false);
  expect(publish([bound()], { ...signedApk, card_id: id("card", 2) })).toBe(
    false,
  );
  expect(
    publish([bound()], {
      ...signedApk,
      kind: "evidence",
    } as Attachment),
  ).toBe(false);
  expect(
    releaseChainSigned({ decision_id: key, card_id: c }, [bound()]),
  ).toEqual([{ decision_id: key, request_id: "f".repeat(32), sha256: signed }]);
  // The per-APK publish path is unchanged and never reads chain events.
  expect(
    approvesPublication(
      project,
      signedApk,
      { ...chain, resolution: { ...resolution, option: "publish" } },
      undefined,
      [],
      [bound()],
    ),
  ).toBe(false);
});

const withReleaseOps = (): CommandState => ({
  ...fixture(),
  roles: [...fixture().roles, role("release_ops"), role("pm")],
  cards: [],
  work_items: [],
  assignments: [],
  runs: [],
  project_preferences: [
    { id: project, flow_version: 5, auto_merge_after_minutes: null },
  ],
});

test("the packaging template creates the chain's work items with their dependencies", () => {
  const created = value(
    createCard(
      withReleaseOps(),
      human,
      {
        title: "安卓测试包",
        goal: "出一个测试包",
        repo: "example/repo",
        base_branch: "main",
        acceptance_criteria: ["测试站可下载"],
        source: { kind: "quote", text: "打包" },
        template_id: "release",
      },
      ports(),
    ),
  );
  const items = created.changes
    .filter((ch) => ch.collection === "work_items")
    .map((ch) => ch.entity as import("./entities.js").WorkItem);
  const byKey = new Map(items.map((w) => [w.template_key, w]));
  expect(items.map((w) => w.title)).toEqual([
    "出包",
    "送签",
    "冒烟",
    "外发",
    "版本说明",
    "PM 验收",
  ]);
  for (const [k, dep] of [
    ["signing", "build"],
    ["smoke", "signing"],
    ["publish", "smoke"],
    ["release_notes", "publish"],
  ] as const)
    expect(byKey.get(k)?.depends_on).toEqual([byKey.get(dep)?.id]);
  expect(byKey.get("build")?.depends_on).toEqual([]);
  expect(byKey.get("pm_acceptance")?.depends_on).toEqual([]);
  // Projects without the release role cannot create a half-staffed chain.
  expect(
    createCard(
      { ...withReleaseOps(), roles: fixture().roles },
      human,
      {
        title: "安卓测试包",
        goal: "出一个测试包",
        repo: "example/repo",
        base_branch: "main",
        acceptance_criteria: ["测试站可下载"],
        source: { kind: "quote", text: "打包" },
        template_id: "release",
      },
      ports(),
    ),
  ).toMatchObject({ ok: false });
});

const rejection = (f: () => void) => {
  try {
    f();
  } catch (e) {
    return (e as { error?: { message?: string } }).error?.message ?? "";
  }
  return "";
};
test("template dependencies may only name earlier items of the same template", () => {
  const roles = withReleaseOps().roles;
  expect(() => validateCardTemplate(releaseCardTemplate, roles)).not.toThrow();
  const items = releaseCardTemplate.work_items;
  for (const work_items of [
    [{ ...items[0], depends_on: ["build"] }, ...items.slice(1)],
    [items[0], { ...items[1], depends_on: ["smoke"] }, ...items.slice(2)],
    [items[0], { ...items[1], depends_on: ["missing"] }, ...items.slice(2)],
    [
      items[0],
      { ...items[1], depends_on: ["build", "build"] },
      ...items.slice(2),
    ],
    [items[0], { ...items[1], depends_on: "build" }, ...items.slice(2)],
  ])
    expect(
      rejection(() =>
        validateCardTemplate(
          {
            ...releaseCardTemplate,
            work_items,
          } as unknown as typeof releaseCardTemplate,
          roles,
        ),
      ),
    ).toContain("依赖");
});

test("C-612: an artifact on the chain basis must carry a digest the approved chain binds", async () => {
  const io = ports();
  const posted = value(
    postComment(fixture(), actor(), { card_id: c, body: "包" }, io),
  );
  if (!posted.data) throw Error("missing entry");
  const entry = posted.data.id;
  const base = apply(fixture(), posted);
  const general: Decision = {
    ...chain,
    id: id("decision", 2),
    key: id("decision", 2),
    category: "general",
    options: [{ key: "ok", description: "普通依据", impact: "无" }],
    resolution: { ...resolution, option: "ok" },
  };
  const upload = async (
    sha256: string,
    over: {
      decision?: Decision;
      events?: Event[];
      basis?: string;
      kind?: "artifact" | "evidence";
    } = {},
  ) =>
    uploadAttachment(
      {
        ...base,
        decisions: [...base.decisions, over.decision ?? chain, general],
        events: [...base.events, ...(over.events ?? [])],
      },
      actor(),
      {
        card_id: c,
        mime: "application/vnd.android.package-archive",
        kind: over.kind ?? "artifact",
        basis: (over.basis ?? key) as NonNullable<Attachment["basis"]>,
        attach_to: { kind: "timeline_entry", id: entry },
      },
      value(
        await prepareAttachment(sha256, new Uint8Array([1]), {
          put: async (d) => ({ storage_path: `attachments/${d}` }),
          get: async () => undefined,
        }),
      ),
      io,
    );
  // The approved unsigned digest, and a signed digest bound from a system receipt.
  expect((await upload(unsigned)).ok).toBe(true);
  expect((await upload(signed, { events: [bound()] })).ok).toBe(true);
  // Other bytes on the chain basis are refused at intake, not later at signing.
  for (const [sha256, events] of [
    ["e".repeat(64), [bound()]],
    [signed, []],
    [signed, [bound({ actor: human })]],
    [signed, [bound({ card_id: id("card", 2) })]],
  ] as const)
    expect(await upload(sha256, { events: [...events] })).toMatchObject({
      ok: false,
      error: { code: "validation_failed" },
    });
  // A chain that is not approved, or no longer live, is no basis for intake.
  const { resolution: _answer, ...unanswered } = chain;
  for (const decision of [
    { ...chain, resolution: { ...resolution, option: "reject" } },
    { ...chain, superseded_by: id("decision", 3) },
    { ...unanswered, status: "open" } as Decision,
  ])
    expect(await upload(unsigned, { decision })).toMatchObject({
      ok: false,
      error: { code: "illegal_transition" },
    });
  // Ordinary bases and evidence keep their existing use.
  expect((await upload("e".repeat(64), { basis: general.key })).ok).toBe(true);
  expect((await upload("e".repeat(64), { kind: "evidence" })).ok).toBe(true);
});

test("C-612: a chain publishes only the signed bytes the card's smoke step accepted", () => {
  const smoke = (over: Partial<WorkItem> = {}) =>
    ({
      id: id("work_item", 7),
      card_id: c,
      kind: "produce",
      template_key: "smoke",
      status: "accepted",
      ...over,
    }) as WorkItem;
  const delivered = (sha: string, over: Partial<Delivery> = {}) =>
    ({
      id: "D-7",
      work_item_id: id("work_item", 7),
      status: "accepted",
      subject: { kind: "artifact_sha256", value: sha },
      ...over,
    }) as Delivery;
  // No smoke step on the card: unchanged.
  expect(releaseChainSmoked(c, signed, [], [])).toBe(true);
  expect(releaseChainSmoked(c, signed, [smoke()], [delivered(signed)])).toBe(
    true,
  );
  expect(
    releaseChainSmoked(c, signed, [smoke()], [delivered(signed.toUpperCase())]),
  ).toBe(true);
  for (const [items, deliveries] of [
    [[smoke({ status: "in_progress" })], [delivered(signed)]],
    [[smoke()], [delivered(unsigned)]],
    [[smoke()], [delivered(signed, { status: "rejected" })]],
    [
      [smoke()],
      [delivered(signed, { subject: { kind: "git_head", value: commit } })],
    ],
    [[smoke()], []],
  ] as const)
    expect(releaseChainSmoked(c, signed, [...items], [...deliveries])).toBe(
      false,
    );
  // A cancelled smoke step (e.g. with its card) never passes; another card's does not hold this one.
  expect(
    releaseChainSmoked(c, signed, [smoke({ status: "cancelled" })], []),
  ).toBe(false);
  expect(
    releaseChainSmoked(
      c,
      signed,
      [smoke({ status: "cancelled" })],
      [delivered(signed)],
    ),
  ).toBe(false);
  expect(
    releaseChainSmoked(
      c,
      signed,
      [smoke({ card_id: id("card", 2), status: "todo" })],
      [],
    ),
  ).toBe(true);
});
