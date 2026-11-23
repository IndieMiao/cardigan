import type { Attachment, Decision } from "@cardigan/domain";
import { Store } from "@cardigan/store";
import { expect, test, vi } from "vitest";
import { authenticate } from "./auth.js";
import {
  card_id,
  NOW,
  project_id,
  seedProject,
  serverCard,
} from "./test-support.js";
import { PublicationError, publicationTool } from "./tools/publish-artifact.js";

test("the actual MCP handler checks the token, card and stored decision before host IO, and durably claims each decision once", async () => {
  const store = Store.open({ dbPath: ":memory:" });
  try {
    const { assignment: a, timeline } = seedProject(store);
    store.uow.run((tx) =>
      tx.assignments.put(project_id, { ...a, role_id: "release_ops" }),
    );
    const token = store.issueToken({
      project_id,
      assignment_id: a.id,
      role: { role_version: 1, allowed_tools: ["publish_artifact"] },
    });
    const identity = authenticate(store, token.token);
    if (!identity.ok) throw Error();
    const ctx = { identity: identity.value, store, revalidateToken: vi.fn() };
    const digest = "a".repeat(64);
    const qid = "Q-1" as Decision["id"];
    const request = {
      attachment_id: "attachment-1",
      decision_id: qid,
      version: "1.0",
      versionCode: 1,
    };
    const attachment: Attachment = {
      id: request.attachment_id,
      kind: "evidence",
      card_id,
      sha256: digest,
      size: 6,
      mime: "application/octet-stream",
      uploaded_by: "human",
      storage_path: "",
      attach_to: { kind: "timeline_entry", id: timeline[0]!.id },
    };
    store.uow.run((tx) => tx.attachments.put(project_id, attachment));
    let url = "https://example.invalid/test/app.apk";
    const pub = vi.fn(async (_p, _a, _r, claim, current) => {
      claim(url);
      current();
      return { url, size: 6, sha256: digest };
    });
    const tool = publicationTool({ publishArtifact: pub });
    expect(tool.input.safeParse({ ...request, path: "./file" }).success).toBe(
      false,
    );
    const call = () => tool.handler(request, ctx);
    await expect(call()).rejects.toThrow("approval");
    expect(pub).not.toHaveBeenCalled();
    const decision: Decision = {
      id: qid,
      key: qid,
      category: "publish",
      card_id,
      kind: "approve",
      target: { subject: { kind: "artifact_sha256", value: digest } },
      attachment_ids: [attachment.id],
      status: "resolved",
      decider: "human",
      options: [
        { key: "publish", description: `发布到 ${url}`, impact: "公开" },
      ],
      recommended: "publish",
      question: "外发？",
      context: "测试",
      raised_by: "human",
      affected_cards: [card_id],
      affected_work_items: [],
      blocking: false,
      doc_refs: [],
      resolution: {
        option: "publish",
        rationale: "通过",
        resolved_by: "human",
        via: "needs_you",
        via_chain: [],
        raw_quote: "通过",
        at: NOW,
      },
    };
    store.uow.run((tx) => tx.decisions.put(project_id, decision));
    url = "https://other.invalid/test/app.apk";
    await expect(call()).rejects.toThrow("approval");
    url = "https://example.invalid/test/app.apk";
    await expect(call()).resolves.toMatchObject({ sha256: digest });
    await expect(call()).rejects.toThrow("already_claimed");
    const entries = store.uow.read((tx) =>
      tx.timeline
        .list(project_id)
        .map((e) => e.body)
        .join("\n"),
    );
    expect(entries).toContain("failed");
    expect(entries).toContain("https://example.invalid/test/app.apk · 6 bytes");
    store.uow.run((tx) => {
      tx.cards.put(project_id, { ...serverCard, sensitive: true });
      tx.assignments.put(project_id, {
        ...a,
        scope: "standing",
        work_item_id: undefined,
        role_id: "pm",
        standing_mode: "office",
      } as never);
    });
    await expect(call()).rejects.toThrow("scope");
  } finally {
    store.close();
  }
});

test("a failure before the first OSS write leaves the approval for exactly one retry", async () => {
  const store = Store.open({ dbPath: ":memory:" });
  try {
    const { assignment: a, timeline } = seedProject(store);
    store.uow.run((tx) =>
      tx.assignments.put(project_id, { ...a, role_id: "release_ops" }),
    );
    const token = store.issueToken({
      project_id,
      assignment_id: a.id,
      role: { role_version: 1, allowed_tools: ["publish_artifact"] },
    });
    const identity = authenticate(store, token.token);
    if (!identity.ok) throw Error();
    const ctx = { identity: identity.value, store, revalidateToken: vi.fn() };
    const digest = "a".repeat(64),
      url = "https://example.invalid/test/app.apk";
    const request = {
      attachment_id: "attachment-1",
      decision_id: "Q-1",
      version: "1.0",
      versionCode: 1,
    };
    store.uow.run((tx) => {
      tx.attachments.put(project_id, {
        id: request.attachment_id,
        kind: "evidence",
        card_id,
        sha256: digest,
        size: 6,
        mime: "application/octet-stream",
        uploaded_by: "human",
        storage_path: "",
        attach_to: { kind: "timeline_entry", id: timeline[0]!.id },
      });
      tx.decisions.put(project_id, {
        id: "Q-1" as Decision["id"],
        key: "Q-1",
        category: "publish",
        card_id,
        kind: "approve",
        target: { subject: { kind: "artifact_sha256", value: digest } },
        attachment_ids: [request.attachment_id],
        status: "resolved",
        decider: "human",
        options: [
          { key: "publish", description: `发布到 ${url}`, impact: "公开" },
        ],
        recommended: "publish",
        question: "外发？",
        context: "测试",
        raised_by: "human",
        affected_cards: [card_id],
        affected_work_items: [],
        blocking: false,
        doc_refs: [],
        resolution: {
          option: "publish",
          rationale: "通过",
          resolved_by: "human",
          via: "needs_you",
          via_chain: [],
          raw_quote: "通过",
          at: NOW,
        },
      });
    });
    let fail: string | undefined = "signature";
    const pub = vi.fn(async (_p, _a, _r, claim: (u: string) => void) => {
      if (fail) throw new PublicationError(fail as never);
      claim(url);
      return { url, size: 6, sha256: digest };
    });
    const call = () =>
      publicationTool({ publishArtifact: pub }).handler(request, ctx);
    await expect(call()).rejects.toThrow(
      "signature（未写入，修复后可用同一拍板重试 1 次）",
    );
    fail = "immutable_prefix";
    await expect(call()).rejects.toThrow(
      "immutable_prefix（未写入，本拍板重试已用尽",
    );
    fail = undefined;
    await expect(call()).rejects.toThrow("retry_exhausted");
    expect(pub).toHaveBeenCalledTimes(2);

    // Attempts are counted per approval.
    store.uow.run((tx) =>
      tx.decisions.put(project_id, {
        ...tx.decisions.get(project_id, "Q-1" as Decision["id"])!,
        id: "Q-2" as Decision["id"],
        key: "Q-2",
      }),
    );
    const second = { ...request, decision_id: "Q-2" };
    const tool = publicationTool({ publishArtifact: pub });
    fail = "manifest";
    await expect(tool.handler(second, ctx)).rejects.toThrow("重试 1 次");
    fail = undefined;
    await expect(tool.handler(second, ctx)).resolves.toMatchObject({ url });
    await expect(tool.handler(second, ctx)).rejects.toThrow("already_claimed");
    expect(pub).toHaveBeenCalledTimes(4);

    // A failure after the claim stays claimed: no retry note.
    store.uow.run((tx) =>
      tx.decisions.put(project_id, {
        ...tx.decisions.get(project_id, "Q-1" as Decision["id"])!,
        id: "Q-3" as Decision["id"],
        key: "Q-3",
      }),
    );
    const late = vi.fn(async (_p, _a, _r, claim: (u: string) => void) => {
      claim(url);
      throw new PublicationError("upload");
    });
    const third = { ...request, decision_id: "Q-3" };
    const error = await publicationTool({ publishArtifact: late })
      .handler(third, ctx)
      .catch((e: Error) => e);
    expect(String(error)).toContain("upload");
    expect(String(error)).not.toContain("未写入");
    await expect(
      publicationTool({ publishArtifact: late }).handler(third, ctx),
    ).rejects.toThrow("already_claimed");
    expect(late).toHaveBeenCalledOnce();
  } finally {
    store.close();
  }
});
