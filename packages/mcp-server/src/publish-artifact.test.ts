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
  workItems,
} from "./test-support.js";
import {
  continuePublication,
  interruptedPublication,
  MAX_PUBLICATION_CONTINUATIONS,
  PublicationError,
  publicationTool,
} from "./tools/publish-artifact.js";

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

/** C-609: an approved publication of one artifact by a release assignment. */
function approved(digest: string, qid: Decision["id"], attachmentId: string) {
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
  if (!identity.ok) throw Error();
  const ctx = { identity: identity.value, store, revalidateToken: vi.fn() };
  const request = {
    attachment_id: attachmentId,
    decision_id: qid,
    version: "1.0",
    versionCode: 1,
  };
  store.uow.run((tx) =>
    tx.attachments.put(project_id, {
      id: request.attachment_id,
      kind: "evidence",
      card_id,
      sha256: digest,
      size: 6,
      mime: "application/octet-stream",
      uploaded_by: "human",
      storage_path: "",
      attach_to: { kind: "timeline_entry", id: timeline[0]?.id ?? "" },
    }),
  );
  const url = "https://example.invalid/test/app.apk";
  store.uow.run((tx) =>
    tx.decisions.put(project_id, {
      id: qid,
      key: qid,
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
    }),
  );
  const events = () =>
    store.uow.read((tx) =>
      tx.events
        .listAfter(project_id, card_id, 0)
        .filter((e) => e.type.startsWith("artifact_publication_")),
    );
  return { store, ctx, request, url, assignment: a, events };
}

test("C-609: a claim cut off before its result continues under the same approval; never twice at once, never after verification", async () => {
  const digest = "b".repeat(64);
  const f = approved(digest, "Q-2" as Decision["id"], "attachment-2");
  const { store, ctx, request, url } = f;
  try {
    // No claim yet: an occupied prefix is sealed, and nothing is claimed.
    const sealed = publicationTool({
      publishArtifact: async (_p, _a, _r, claim) => {
        claim(url, true);
        return { url, size: 6, sha256: digest };
      },
    });
    await expect(sealed.handler(request, ctx)).rejects.toThrow(
      "immutable_prefix",
    );
    // The first attempt claims, then the server stops mid-upload.
    let cut: (() => void) | undefined;
    const first = publicationTool({
      publishArtifact: async (_p, _a, _r, claim) => {
        claim(url);
        await new Promise<void>((resolve) => {
          cut = resolve;
        });
        throw new Error("server stopped");
      },
    });
    const running = first.handler(request, ctx);
    await vi.waitFor(() => expect(cut).toBeDefined());
    // While it runs, nobody else continues it: refused before any host IO
    // and without an audit row (C-612 one executor per approval).
    const resume = publicationTool({
      publishArtifact: async (_p, _a, _r, claim) => {
        claim(url, true);
        return { url, size: 6, sha256: digest };
      },
    });
    const before = f.events().length;
    await expect(resume.handler(request, ctx)).rejects.toThrow("in_progress");
    expect(f.events()).toHaveLength(before);
    cut?.();
    await expect(running).rejects.toThrow();
    // Next server: the same decision continues the same URL and artifact.
    await expect(resume.handler(request, ctx)).resolves.toMatchObject({
      sha256: digest,
    });
    await expect(resume.handler(request, ctx)).rejects.toThrow(
      "already_claimed",
    );
    const types = f.events().map((e) => e.type);
    expect(
      types.filter((t) => t === "artifact_publication_claimed"),
    ).toHaveLength(1);
    expect(
      types.filter((t) => t === "artifact_publication_resumed"),
    ).toHaveLength(1);
    expect(
      types.filter((t) => t === "artifact_publication_verified"),
    ).toHaveLength(1);
  } finally {
    store.close();
  }
});

test("C-609: a run the shutdown cut off records no outcome; the host continues it as the system, within the same approval", async () => {
  const digest = "c".repeat(64);
  const f = approved(digest, "Q-3" as Decision["id"], "attachment-3");
  const { store, ctx, request, url, assignment } = f;
  try {
    // The server stops after the APK write: the publisher reports interrupted.
    const cut = publicationTool({
      publishArtifact: async (_p, _a, _r, claim) => {
        claim(url);
        throw new PublicationError("interrupted");
      },
    });
    await expect(cut.handler(request, ctx)).rejects.toThrow("interrupted");
    expect(f.events().map((e) => e.type)).toEqual([
      "artifact_publication_requested",
      "artifact_publication_claimed",
    ]);
    expect(interruptedPublication(f.events())).toBe(true);
    // Nobody calls again: the next server continues on its own.
    const publish = vi.fn(async (_p, _a, _r, claim) => {
      claim(url, true);
      return { url, size: 6, sha256: digest };
    });
    await expect(
      continuePublication({ publishArtifact: publish }, store, {
        project: project_id,
        assignment: assignment.id,
        request,
      }),
    ).resolves.toMatchObject({ url, sha256: digest });
    const events = f.events();
    expect(events.map((e) => [e.type, e.actor.kind])).toEqual([
      ["artifact_publication_requested", "assignment"],
      ["artifact_publication_claimed", "assignment"],
      ["artifact_publication_continued", "system"],
      ["artifact_publication_resumed", "system"],
      ["artifact_publication_verified", "system"],
    ]);
    expect(interruptedPublication(events)).toBe(false);
  } finally {
    store.close();
  }
});

test("C-609: an automatic continuation keeps every check and is bounded", async () => {
  const digest = "d".repeat(64);
  const f = approved(digest, "Q-4" as Decision["id"], "attachment-4");
  const { store, ctx, request, url, assignment } = f;
  try {
    await expect(
      publicationTool({
        publishArtifact: async (_p, _a, _r, claim) => {
          claim(url);
          throw new PublicationError("interrupted");
        },
      }).handler(request, ctx),
    ).rejects.toThrow("interrupted");
    const job = { project: project_id, assignment: assignment.id, request };
    // Each automatic attempt that is cut off again counts; after the limit
    // only the caller can try again.
    for (let i = 0; i < MAX_PUBLICATION_CONTINUATIONS; i++) {
      expect(interruptedPublication(f.events())).toBe(true);
      await expect(
        continuePublication(
          {
            publishArtifact: async (_p, _a, _r, claim) => {
              claim(url, true);
              throw new PublicationError("interrupted");
            },
          },
          store,
          job,
        ),
      ).rejects.toThrow("interrupted");
    }
    expect(interruptedPublication(f.events())).toBe(false);
    // An assignment no longer active cannot be continued on its behalf.
    store.uow.run((tx) =>
      tx.assignments.put(project_id, { ...assignment, status: "released" }),
    );
    const publish = vi.fn();
    await expect(
      continuePublication({ publishArtifact: publish }, store, job),
    ).rejects.toThrow("scope");
    expect(publish).not.toHaveBeenCalled();
  } finally {
    store.close();
  }
});

test("C-609: only a run without an outcome is interrupted", () => {
  const e = (type: string) => ({
    type: `artifact_publication_${type}`,
    actor: { kind: "system" as const, project_id },
  });
  expect(interruptedPublication([e("requested")])).toBe(true);
  expect(interruptedPublication([e("requested"), e("failed")])).toBe(false);
  // Two overlapping calls: one refused, the other cut off.
  expect(
    interruptedPublication([
      e("requested"),
      e("requested"),
      e("claimed"),
      e("failed"),
    ]),
  ).toBe(true);
  expect(
    interruptedPublication([e("requested"), e("claimed"), e("verified")]),
  ).toBe(false);
  // Claims written before C-609 have no request record: never continued.
  expect(interruptedPublication([e("claimed")])).toBe(false);
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
    store.uow.run((tx) =>
      tx.decisions.put(
        project_id,
        approval("Q-2", digest, [
          { key: "publish", description: `发布到 ${url}`, impact: "公开" },
        ]),
      ),
    );
    const first = tool.handler(request, ctx);
    await expect(tool.handler(request, ctx)).rejects.toThrow("in_progress");
    // Another approval for the same APK is a second executor too.
    await expect(
      tool.handler({ ...request, decision_id: "Q-2" }, ctx),
    ).rejects.toThrow("in_progress");
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
    // A chain that claimed one place continues only there.
    const late = vi.fn(async (_p, _a, _r, claim: (u: string) => void) => {
      claim(target);
      throw new PublicationError("download");
    });
    await expect(
      publicationTool({ publishArtifact: late }).handler(request, ctx),
    ).rejects.toThrow("download");
    const other = `https://example.invalid/test/2.0-${signed.slice(0, 12)}/app.apk`;
    target = other;
    await expect(
      publicationTool({ publishArtifact: late }).handler(
        { ...request, version: "2.0" },
        ctx,
      ),
    ).rejects.toThrow("already_claimed");
    store.uow.run((tx) => {
      tx.attachments.put(project_id, {
        ...(tx.attachments.get(
          project_id,
          "attachment-1" as never,
        ) as Attachment),
        id: "attachment-9",
        sha256: "d".repeat(64),
      } as Attachment);
      tx.events.append(project_id, {
        id: tx.ids.nextEventId(),
        seq: tx.ids.nextEventSequence(project_id, card_id),
        card_id,
        type: "release_chain_signed",
        actor: { kind: "system", project_id },
        created_at: NOW,
        payload: {
          decision_id: "Q-1",
          request_id: "e".repeat(32),
          sha256: "d".repeat(64),
        },
      });
    });
    await expect(
      tool.handler({ ...request, attachment_id: "attachment-9" }, ctx),
    ).rejects.toThrow("already_claimed");
    // The version change reached the host but was refused at the claim, before any write.
    expect(late).toHaveBeenCalledTimes(2);
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

test("C-612: under a chain only the signed APK the card's smoke step accepted is published", async () => {
  const { store, entry, ctx } = publisherContext();
  try {
    const unsigned = "a".repeat(64),
      signed = "b".repeat(64),
      template = "https://example.invalid/test/<version>-<sha12>/app.apk",
      url = `https://example.invalid/test/1.0-${signed.slice(0, 12)}/app.apk`;
    const smoke = (status: string) =>
      ({
        ...workItems,
        id: "W-7",
        title: "冒烟",
        role_id: "release_ops",
        template_key: "smoke",
        status,
      }) as never;
    const delivered = (sha: string) =>
      ({
        id: "D-7",
        work_item_id: "W-7",
        kind: "test_report",
        summary: "冒烟通过",
        subject: { kind: "artifact_sha256", value: sha },
        status: "accepted",
        requested_verifiers: [],
        attachments: [],
        author: "assignment:A-1",
        created_at: NOW,
      }) as never;
    store.uow.run((tx) => {
      tx.decisions.put(
        project_id,
        approval(
          "Q-1",
          unsigned,
          [
            {
              key: "release_chain",
              description: `发布链 ${"c".repeat(40)} 发布到 ${template}`,
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
      });
      tx.work_items.put(project_id, smoke("in_progress"));
    });
    const request = {
      attachment_id: "attachment-1",
      decision_id: "Q-1",
      version: "1.0",
      versionCode: 1,
    };
    const pub = vi.fn(async (_p, _a, _r, claim: (u: string) => void) => {
      claim(url);
      return { url, size: 6, sha256: signed };
    });
    const tool = publicationTool({ publishArtifact: pub });
    // Smoke not finished, cancelled (e.g. with its card), or it accepted
    // other bytes: refused before host IO.
    await expect(tool.handler(request, ctx)).rejects.toThrow("approval");
    store.uow.run((tx) => tx.work_items.put(project_id, smoke("cancelled")));
    await expect(tool.handler(request, ctx)).rejects.toThrow("approval");
    store.uow.run((tx) => {
      tx.work_items.put(project_id, smoke("accepted"));
      tx.deliveries.put(project_id, delivered("d".repeat(64)));
    });
    await expect(tool.handler(request, ctx)).rejects.toThrow("approval");
    expect(pub).not.toHaveBeenCalled();
    store.uow.run((tx) => tx.deliveries.put(project_id, delivered(signed)));
    await expect(tool.handler(request, ctx)).resolves.toMatchObject({
      url,
      sha256: signed,
    });
  } finally {
    store.close();
  }
});

/** C-712: register the publishing role so its note write is authorized. */
function releaseRole(store: Store) {
  store.uow.run((tx) =>
    tx.roles.put(project_id, {
      role_id: "release_ops",
      role_version: 1,
      allowed_tools: ["publish_artifact"],
      capabilities: [],
    }),
  );
}
const projectNotes = (store: Store) =>
  store.uow.read((tx) =>
    tx.events
      .listAfter(project_id, undefined, 0)
      .filter((e) => e.type === "release_note_written"),
  );
const publishOnce = (digest: string, url: string) =>
  vi.fn(async (_p, _a, _r, claim: (url: string) => void) => {
    claim(url);
    return { url, size: 6, sha256: digest };
  });

test("C-712: without a release note the publication is unchanged and the result says the note is missing", async () => {
  const digest = "d".repeat(64);
  const f = approved(digest, "Q-4" as Decision["id"], "attachment-4");
  try {
    releaseRole(f.store);
    const result = await publicationTool({
      publishArtifact: publishOnce(digest, f.url),
    }).handler(f.request, f.ctx);
    expect(result).toMatchObject({
      url: f.url,
      size: 6,
      sha256: digest,
      release_note: null,
      release_note_hint: "本版本还没有发版说明，可用 write_release_note 补写",
      merged_cards: { basis: "recent", cards: [] },
    });
    expect(f.events().map((e) => e.type)).toEqual([
      "artifact_publication_requested",
      "artifact_publication_claimed",
      "artifact_publication_verified",
    ]);
    // The audit payload carries exactly the publication request.
    expect(Object.keys(f.events()[0]?.payload as object).sort()).toEqual(
      [
        "attachment_id",
        "decision_id",
        "result",
        "version",
        "versionCode",
      ].sort(),
    );
    expect(projectNotes(f.store)).toEqual([]);
  } finally {
    f.store.close();
  }
});

test("C-712: a release note given with publish_artifact is saved for the verified version only", async () => {
  const digest = "e".repeat(64);
  const f = approved(digest, "Q-5" as Decision["id"], "attachment-5");
  try {
    releaseRole(f.store);
    const pub = publishOnce(digest, f.url);
    const tool = publicationTool({ publishArtifact: pub });
    // An unusable note is rejected before any host IO.
    for (const release_note of ["  ", "x".repeat(4001)])
      await expect(
        tool.handler({ ...f.request, release_note }, f.ctx),
      ).rejects.toThrow();
    expect(pub).not.toHaveBeenCalled();
    expect(f.events()).toEqual([]);
    const result = await tool.handler(
      { ...f.request, release_note: "修复了闪退" },
      f.ctx,
    );
    expect(result).toMatchObject({
      url: f.url,
      release_note: {
        version: "1.0",
        version_code: 1,
        decision_id: "Q-5",
        body: "修复了闪退",
        revision: 1,
      },
      merged_cards: { basis: "recent" },
    });
    expect(result).not.toHaveProperty("release_note_hint");
    expect(projectNotes(f.store).map((e) => e.payload)).toEqual([
      {
        version: "1.0",
        version_code: 1,
        decision_id: "Q-5",
        body: "修复了闪退",
        revision: 1,
        source: "publish_artifact",
      },
    ]);
  } finally {
    f.store.close();
  }
});

test("C-712: a note that cannot be saved never turns a verified publication into a failure", async () => {
  const digest = "f".repeat(64);
  const f = approved(digest, "Q-6" as Decision["id"], "attachment-6");
  try {
    // No stored role version grants the tool, so the note write is refused.
    const result = await publicationTool({
      publishArtifact: publishOnce(digest, f.url),
    }).handler({ ...f.request, release_note: "说明" }, f.ctx);
    expect(result).toMatchObject({
      url: f.url,
      sha256: digest,
      release_note: null,
      merged_cards: { basis: "recent" },
    });
    expect(
      String((result as { release_note_hint: string }).release_note_hint),
    ).toContain("发布不受影响");
    expect(f.events().map((e) => e.type)).toContain(
      "artifact_publication_verified",
    );
    expect(projectNotes(f.store)).toEqual([]);
  } finally {
    f.store.close();
  }
});
