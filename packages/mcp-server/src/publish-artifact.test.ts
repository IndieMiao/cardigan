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

function publisherContext() {
  const store = Store.open({ dbPath: ":memory:" });
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
  const entry = timeline[0]?.id;
  if (!identity.ok || !entry) throw Error();
  return {
    store,
    entry,
    ctx: { identity: identity.value, store, revalidateToken: vi.fn() },
  };
}
const approval = (
  id: string,
  digest: string,
  options: Decision["options"],
  option = "publish",
  attachment_ids: string[] = ["attachment-1"],
): Decision => ({
  id: id as Decision["id"],
  key: id as Decision["id"],
  category: "publish",
  card_id,
  kind: "approve",
  target: { subject: { kind: "artifact_sha256", value: digest } },
  ...(attachment_ids.length ? { attachment_ids } : {}),
  status: "resolved",
  decider: "human",
  options,
  recommended: option,
  question: "外发？",
  context: "测试",
  raised_by: "human",
  affected_cards: [card_id],
  affected_work_items: [],
  blocking: false,
  doc_refs: [],
  resolution: {
    option,
    rationale: "通过",
    resolved_by: "human",
    via: "needs_you",
    via_chain: [],
    raw_quote: "通过",
    at: NOW,
  },
});

test("a failure before the first OSS write consumes nothing; after a write the same approval resumes", async () => {
  const { store, entry, ctx } = publisherContext();
  try {
    const digest = "a".repeat(64),
      url = "https://example.invalid/test/app.apk";
    const request = {
      attachment_id: "attachment-1",
      decision_id: "Q-1",
      version: "1.0",
      versionCode: 1,
    };
    const publish = [
      { key: "publish", description: `发布到 ${url}`, impact: "公开" },
    ];
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
        attach_to: { kind: "timeline_entry", id: entry },
      });
      tx.decisions.put(project_id, approval("Q-1", digest, publish));
    });
    let fail: string | undefined = "signature";
    const pub = vi.fn(async (_p, _a, _r, claim: (u: string) => void) => {
      if (fail) throw new PublicationError(fail as never);
      claim(url);
      return { url, size: 6, sha256: digest };
    });
    const call = () =>
      publicationTool({ publishArtifact: pub }).handler(request, ctx);
    for (const category of [
      "signature",
      "manifest",
      "immutable_prefix",
      "configuration",
      "signature",
    ]) {
      fail = category;
      await expect(call()).rejects.toThrow(
        `${category}（未写入，修复后可用同一授权直接重试）`,
      );
    }
    fail = undefined;
    await expect(call()).resolves.toMatchObject({ url });
    await expect(call()).rejects.toThrow("already_claimed");
    expect(pub).toHaveBeenCalledTimes(6);

    // A claimed attempt that failed after writing continues with the same
    // approval: the host resumes only a lone APK this card already claimed.
    store.uow.run((tx) =>
      tx.decisions.put(project_id, approval("Q-3", digest, publish)),
    );
    const third = { ...request, decision_id: "Q-3" };
    let resumed = false;
    const late = vi.fn(
      async (_p, _a, _r, claim: (u: string, r?: boolean) => void) => {
        claim(url, resumed);
        if (!resumed) throw new PublicationError("download");
        return { url, size: 6, sha256: digest };
      },
    );
    const error = await publicationTool({ publishArtifact: late })
      .handler(third, ctx)
      .catch((e: Error) => e);
    expect(String(error)).toContain("download（可能已写入部分对象");
    resumed = true;
    await expect(
      publicationTool({ publishArtifact: late }).handler(third, ctx),
    ).resolves.toMatchObject({ url });
    expect(late).toHaveBeenCalledTimes(2);
    const bodies = store.uow.read((tx) =>
      tx.timeline.list(project_id).map((e) => e.body),
    );
    expect(bodies.some((b) => b.includes("Q-3") && b.includes("续做"))).toBe(
      true,
    );

    // Resume is refused for a URL this card never claimed for that digest.
    const other = "https://example.invalid/other/app.apk";
    store.uow.run((tx) =>
      tx.decisions.put(
        project_id,
        approval("Q-5", digest, [
          { key: "publish", description: `发布到 ${other}`, impact: "公开" },
        ]),
      ),
    );
    await expect(
      publicationTool({
        publishArtifact: async (_p, _a, _r, claim) => {
          claim(other, true);
          return { url: other, size: 6, sha256: digest };
        },
      }).handler({ ...request, decision_id: "Q-5" }, ctx),
    ).rejects.toThrow("immutable_prefix（未写入");
  } finally {
    store.close();
  }
});

test("one executor per approval: a concurrent call is refused without touching the host", async () => {
  const { store, entry, ctx } = publisherContext();
  try {
    const digest = "a".repeat(64),
      url = "https://example.invalid/test/app.apk";
    store.uow.run((tx) => {
      tx.attachments.put(project_id, {
        id: "attachment-1",
        kind: "evidence",
        card_id,
        sha256: digest,
        size: 6,
        mime: "application/octet-stream",
        uploaded_by: "human",
        storage_path: "",
        attach_to: { kind: "timeline_entry", id: entry },
      });
      tx.decisions.put(
        project_id,
        approval("Q-1", digest, [
          { key: "publish", description: `发布到 ${url}`, impact: "公开" },
        ]),
      );
    });
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const pub = vi.fn(async (_p, _a, _r, claim: (u: string) => void) => {
      await gate;
      claim(url);
      return { url, size: 6, sha256: digest };
    });
    const tool = publicationTool({ publishArtifact: pub });
    const request = {
      attachment_id: "attachment-1",
      decision_id: "Q-1",
      version: "1.0",
      versionCode: 1,
    };
    const first = tool.handler(request, ctx);
    await expect(tool.handler(request, ctx)).rejects.toThrow("in_progress");
    release();
    await expect(first).resolves.toMatchObject({ url });
    expect(pub).toHaveBeenCalledOnce();
    const failed = store.uow.read((tx) =>
      tx.events
        .listAfter(project_id, card_id, 0)
        .filter((e) => e.type === "artifact_publication_failed"),
    );
    expect(failed).toEqual([]);
  } finally {
    store.close();
  }
});

test("an approved release chain publishes the signed APK it bound, at its template URL", async () => {
  const { store, entry, ctx } = publisherContext();
  try {
    const unsigned = "a".repeat(64),
      signed = "b".repeat(64),
      commit = "c".repeat(40),
      template = "https://example.invalid/test/<version>-<sha12>/app.apk",
      url = `https://example.invalid/test/1.0-${signed.slice(0, 12)}/app.apk`;
    store.uow.run((tx) => {
      tx.decisions.put(
        project_id,
        approval(
          "Q-1",
          unsigned,
          [
            {
              key: "release_chain",
              description: `发布链 ${commit} 发布到 ${template}`,
              impact: "按链执行",
            },
          ],
          "release_chain",
          [],
        ),
      );
      tx.attachments.put(project_id, {
        id: "attachment-1",
        kind: "artifact",
        basis: "Q-1" as Decision["id"],
        card_id,
        sha256: signed,
        size: 6,
        mime: "application/vnd.android.package-archive",
        uploaded_by: "system",
        storage_path: "",
        attach_to: { kind: "timeline_entry", id: entry },
      } as Attachment);
    });
    const request = {
      attachment_id: "attachment-1",
      decision_id: "Q-1",
      version: "1.0",
      versionCode: 1,
    };
    let target = url;
    const pub = vi.fn(async (_p, _a, _r, claim: (u: string) => void) => {
      claim(target);
      return { url: target, size: 6, sha256: signed };
    });
    const tool = publicationTool({ publishArtifact: pub });
    // Nothing bound yet: the chain does not cover arbitrary card artifacts.
    await expect(tool.handler(request, ctx)).rejects.toThrow("approval");
    store.uow.run((tx) =>
      tx.events.append(project_id, {
        id: tx.ids.nextEventId(),
        seq: tx.ids.nextEventSequence(project_id, card_id),
        card_id,
        type: "release_chain_signed",
        actor: { kind: "system", project_id },
        created_at: NOW,
        payload: {
          decision_id: "Q-1",
          request_id: "f".repeat(32),
          sha256: signed,
        },
      }),
    );
    target = "https://example.invalid/test/1.0-aaaaaaaaaaaa/app.apk";
    await expect(tool.handler(request, ctx)).rejects.toThrow("approval");
    target = url;
    await expect(tool.handler(request, ctx)).resolves.toMatchObject({
      url,
      sha256: signed,
    });
    await expect(tool.handler(request, ctx)).rejects.toThrow("already_claimed");
  } finally {
    store.close();
  }
});
