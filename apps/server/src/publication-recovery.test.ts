import type { Decision } from "@cardigan/domain";
import { liveLongOperations } from "@cardigan/host";
import { Store } from "@cardigan/store";
import { expect, test, vi } from "vitest";
import {
  card_id,
  NOW,
  project_id,
  seedProject,
} from "../../../packages/mcp-server/src/test-support.js";
import {
  resumeInterruptedPublications,
  trackedPublisher,
} from "./publication-recovery.js";

const digest = "e".repeat(64);
const url = "https://example.invalid/test/app.apk";
const request = {
  attachment_id: "attachment-5",
  decision_id: "Q-5",
  version: "1.0",
  versionCode: 1,
};

/** An approved publication whose first run a restart cut off after its claim. */
function cutOff() {
  const store = Store.open({ dbPath: ":memory:" });
  const { assignment, timeline } = seedProject(store);
  const owner = { ...assignment, role_id: "release_ops" };
  store.uow.run((tx) => {
    tx.assignments.put(project_id, owner);
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
    });
    tx.decisions.put(project_id, {
      id: request.decision_id as Decision["id"],
      key: request.decision_id,
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
    } as Decision);
    for (const [type, result] of [
      ["requested", digest],
      ["claimed", `${url} · ${digest}`],
    ])
      tx.events.append(project_id, {
        id: tx.ids.nextEventId(),
        seq: tx.ids.nextEventSequence(project_id, card_id),
        card_id,
        type: `artifact_publication_${type}`,
        actor: {
          kind: "assignment",
          project_id,
          assignment_id: owner.id,
          role_id: owner.role_id,
          role_version: owner.role_version,
        } as never,
        created_at: NOW,
        payload: { ...request, result },
      });
  });
  const types = () =>
    store.uow.read((tx) =>
      tx.events
        .listAfter(project_id, card_id, 0)
        .map((e) => e.type)
        .filter((t) => t.startsWith("artifact_publication_")),
    );
  return { store, types };
}

test("C-609: the next server continues a cut-off publication without its caller, once, as a managed operation", async () => {
  const { store, types } = cutOff();
  try {
    const seen: unknown[] = [];
    const publish = trackedPublisher(
      store,
      vi.fn(async (_p, _a, _r, claim) => {
        seen.push(liveLongOperations(store).map((o) => o.kind));
        // The prefix holds the APK already: only this claim may continue it.
        claim(url, true);
        return { url, size: 6, sha256: digest };
      }),
    );
    await expect(resumeInterruptedPublications(store, publish)).resolves.toBe(
      1,
    );
    expect(seen).toEqual([["artifact_publication"]]);
    expect(types()).toEqual([
      "artifact_publication_requested",
      "artifact_publication_claimed",
      "artifact_publication_continued",
      "artifact_publication_resumed",
      "artifact_publication_verified",
    ]);
    // Verified: nothing is left to continue.
    await expect(resumeInterruptedPublications(store, publish)).resolves.toBe(
      0,
    );
  } finally {
    store.close();
  }
});

test("C-609: a failure while the server shuts down leaves the publication to the next server", async () => {
  const { store, types } = cutOff();
  try {
    const publish = trackedPublisher(store, async (_p, _a, _r, claim) => {
      claim(url, true);
      publish.drain(); // the server starts shutting down mid-upload
      throw new Error("upload cut off");
    });
    await resumeInterruptedPublications(store, publish);
    expect(types().at(-1)).toBe("artifact_publication_resumed");
    // Still without an outcome: the next server picks it up again.
    const next = trackedPublisher(store, async (_p, _a, _r, claim) => {
      claim(url, true);
      return { url, size: 6, sha256: digest };
    });
    await expect(resumeInterruptedPublications(store, next)).resolves.toBe(1);
    expect(types().at(-1)).toBe("artifact_publication_verified");
  } finally {
    store.close();
  }
});

test("C-609: a genuine failure is recorded and not continued automatically", async () => {
  const { store, types } = cutOff();
  try {
    const publish = trackedPublisher(store, async () => {
      throw new Error("upload refused");
    });
    await resumeInterruptedPublications(store, publish);
    expect(types().at(-1)).toBe("artifact_publication_failed");
    await expect(resumeInterruptedPublications(store, publish)).resolves.toBe(
      0,
    );
  } finally {
    store.close();
  }
});
