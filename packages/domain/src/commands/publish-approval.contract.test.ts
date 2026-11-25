import { expect, test } from "vitest";
import {
  PUBLISH_APPROVAL_FORMAT,
  publicationApprovalProblem,
} from "../artifact-publication.js";
import type { Attachment, Decision } from "../entities.js";
import { type RequestDecisionParams, requestDecision } from "../index.js";
import { actor, fixture, id, ports, value } from "./test-fixtures.js";

const sha = (n: number) => String(n).padStart(64, "a");
const apk = (n: number, card = 1) =>
  ({
    id: `attachment-${n}`,
    sha256: sha(n),
    mime: "application/vnd.android.package-archive",
    size: 10,
    card_id: id("card", card),
    uploaded_by: "human",
    storage_path: `blobs/${n}`,
    attach_to: { kind: "timeline_entry", id: `${id("card", card)}#1` },
    kind: "evidence",
  }) as Attachment;
const state = () => ({
  ...fixture(),
  attachments: [apk(1), apk(2), apk(3, 2)],
});
const office = actor(4, "pm");
const url = "https://dl.example.com/app/1.0.0-aaaaaaaaaaaa/app.apk";
const valid: RequestDecisionParams = {
  card_id: id("card", 1),
  category: "publish",
  kind: "approve",
  question: "发布 1.0.0？",
  context: "测试包",
  options: [
    { key: "publish", description: `发布到 ${url}`, impact: "公开" },
    { key: "reject", description: "不发", impact: "无" },
  ],
  recommended: "publish",
  affected_cards: [],
  affected_work_items: [],
  blocking: false,
  decider: "human",
  plain_summary: {
    changed: "发布测试包",
    impact: "公开下载",
    risk: "对外发布",
  },
  attachment_ids: ["attachment-1"],
  target: { subject: { kind: "artifact_sha256", value: sha(1) } },
};
const raise = (p: Partial<RequestDecisionParams>) =>
  requestDecision(state(), office, { ...valid, ...p }, ports());
const refusal = (p: Partial<RequestDecisionParams>) => {
  const r = raise(p);
  expect(r.ok).toBe(false);
  if (r.ok) return "";
  expect(r.error.code).toBe("validation_failed");
  expect(r.error.message).toContain(PUBLISH_APPROVAL_FORMAT);
  return r.error.message;
};

test("C-754: a well-formed publish approval is raised unchanged", () => {
  const q = value(raise({})).data;
  expect(q.kind).toBe("approve");
  expect(q.kind === "approve" && q.target).toEqual(valid.target);
});

test("C-754: a choose publish decision is refused, naming kind", () => {
  const { target: _target, ...rest } = valid;
  expect(refusal({ ...rest, kind: "choose" })).toContain(
    "kind 须为 approve（当前为 choose）",
  );
});

test("C-754: a missing target is derived from the single attachment", () => {
  const { target: _target, ...rest } = valid;
  const r = requestDecision(state(), office, rest, ports());
  const q = value(r).data;
  expect(q.kind === "approve" && q.target).toEqual({
    subject: { kind: "artifact_sha256", value: sha(1) },
  });
});

test("C-754: a missing target with no attachment is refused, naming both", () => {
  const { target: _target, attachment_ids: _ids, ...rest } = valid;
  const message = (() => {
    const r = requestDecision(state(), office, rest, ports());
    expect(r.ok).toBe(false);
    return r.ok ? "" : r.error.message;
  })();
  expect(message).toContain("attachment_ids 须带要发布的那一个附件");
  expect(message).toContain("缺 target");
});

test("C-754: a target SHA-256 that is not the attachment's is refused", () => {
  expect(
    refusal({
      target: { subject: { kind: "artifact_sha256", value: sha(2) } },
    }),
  ).toContain("target 的 SHA-256 与附件 attachment-1 的完整 SHA-256 不符");
  expect(
    refusal({ target: { subject: { kind: "git_head", value: sha(1) } } }),
  ).toContain("target.subject.kind 须为 artifact_sha256（当前为 git_head）");
});

test("C-754: several attachments are refused, even with a matching target", () => {
  expect(
    refusal({ attachment_ids: ["attachment-1", "attachment-2"] }),
  ).toContain("attachment_ids 只能带要发布的一个附件（当前 2 个）");
});

test("C-754: the publish option must name the final HTTPS APK URL", () => {
  for (const description of [
    "发布",
    `发布到 http://dl.example.com/app.apk`,
    `发布到 ${url} 吧`,
  ])
    expect(
      refusal({
        options: [{ key: "publish", description, impact: "公开" }],
      }),
    ).toContain("publish 选项说明须为“发布到 <最终 HTTPS APK 地址>”");
});

test("C-754: an attachment of another card is refused", () => {
  expect(
    refusal({
      attachment_ids: ["attachment-3"],
      affected_cards: [id("card", 2)],
      target: { subject: { kind: "artifact_sha256", value: sha(3) } },
    }),
  ).toContain("附件 attachment-3 不在拍板所在卡片上");
});

test("C-754: publish decisions without a publish option keep the old rules", () => {
  const { target: _target, attachment_ids: _ids, ...rest } = valid;
  expect(
    requestDecision(
      state(),
      office,
      {
        ...rest,
        kind: "choose",
        options: [{ key: "approve", description: "同意", impact: "公开" }],
        recommended: "approve",
      },
      ports(),
    ).ok,
  ).toBe(true);
});

test("C-754: publication refusals name the approval sub-reason", () => {
  const a = apk(1);
  const resolution = {
    option: "publish",
    rationale: "ok",
    via: "needs_you",
    resolved_by: "human",
    via_chain: [],
    raw_quote: "ok",
    at: "2026-01-01T00:00:00.000Z",
  } as const;
  const resolved: Decision = {
    ...(value(raise({})).data as Decision),
    status: "resolved",
    resolution,
  };
  const why = (q: Decision | undefined) =>
    publicationApprovalProblem("p", a, q, undefined, []);
  expect(why(resolved)).toBeUndefined();
  expect(why(undefined)).toBe("拍板不存在");
  expect(why({ ...resolved, status: "open" })).toBe("拍板尚未批准");
  expect(
    why({
      ...resolved,
      kind: "choose",
    } as unknown as Decision),
  ).toBe("拍板 kind 须为 approve（当前为 choose）");
  expect(
    why({
      ...resolved,
      target: { subject: { kind: "artifact_sha256", value: sha(2) } },
    } as Decision),
  ).toBe("拍板 target 的 SHA-256 与附件不符");
  expect(
    why({ ...resolved, attachment_ids: ["attachment-1", "attachment-2"] }),
  ).toBe("拍板须且只能带这一个附件");
  expect(
    why({
      ...resolved,
      resolution: { ...resolution, via: "pm_office_chat" },
    } as Decision),
  ).toBe("拍板不是所有者在 Needs You 批准，也没有有效的外发代批授权");
  // C-612 release chain: an unapproved or malformed chain is named as such.
  expect(
    why({
      ...resolved,
      options: [
        { key: "release_chain", description: "发布链", impact: "公开" },
      ],
      resolution: { ...resolution, option: "release_chain" },
    }),
  ).toBe("发布链拍板未批准、已失效或没有有效授权");
});
