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
    // C-754: the refusal names the sub-reason and the correct format.
    await expect(call()).rejects.toThrow("approval（拍板不存在）");
    await expect(call()).rejects.toThrow("kind=approve");
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
    await expect(call()).rejects.toThrow(
      "approval（publish 选项说明与本次发布地址不符）",
    );
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
    // While it runs, nobody else continues it.
    const resume = publicationTool({
      publishArtifact: async (_p, _a, _r, claim) => {
        claim(url, true);
        return { url, size: 6, sha256: digest };
      },
    });
    await expect(resume.handler(request, ctx)).rejects.toThrow(
      "already_claimed",
    );
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
