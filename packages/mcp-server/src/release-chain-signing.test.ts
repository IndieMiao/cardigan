import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import {
  type Attachment,
  approvesPublication,
  type Decision,
  type Run,
} from "@cardigan/domain";
import { Store } from "@cardigan/store";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { authenticate } from "./auth.js";
import {
  card_id,
  NOW,
  project_id,
  seedProject,
  serverCard,
  workItems,
} from "./test-support.js";
import { mobileSigningTool } from "./tools/mobile-signing.js";

const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const unsignedBytes = Buffer.from("unsigned-apk"),
  signedBytes = Buffer.from("signed-apk"),
  unsigned = sha(unsignedBytes),
  signed = sha(signedBytes),
  commit = "c".repeat(40),
  rid = "1".repeat(32);
let dataDir = "";
beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "chain-signing-"));
});
afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

function signingRun() {
  const store = Store.open({ dbPath: ":memory:" });
  const tools = ["request_mobile_signature", "upload_attachment"];
  const { assignment: a, timeline } = seedProject(store, {
    allowed_tools: tools,
  });
  const issued = store.issueToken({
    project_id,
    assignment_id: a.id,
    role: { role_version: 1, allowed_tools: tools },
  });
  const caller = authenticate(store, issued.token);
  const entry = timeline[0]?.id;
  if (!caller.ok || !entry) throw Error("missing test actor");
  const ref = {
    machine_id: a.machine_id,
    runtime_machine: "remote",
    launch_generation: { run_id: "R-1" as never, generation: "a".repeat(32) },
    terminal_ref: "t1",
    agent_name: "fixture",
  };
  const r: Run = {
    id: "R-1" as never,
    assignment_id: a.id,
    trigger_event_id: "event-1" as never,
    kind: "initial",
    status: "running",
    role_version: 1,
    model: "fixture",
    agent_cli_version: "test",
    outcome: null,
    summary: "",
    launch_publication: {
      phase: "started",
      generation: "a".repeat(32),
      target: {
        project_id,
        machine_id: a.machine_id,
        session: "test",
        generation: "one",
        fingerprint: "a".repeat(64),
      },
      lease_until: "2099-01-01T00:00:00.000Z",
      agent_name: "fixture",
      work_dir: "fixture",
      sha: null,
      token_id: issued.record.id,
      runtime_ref: ref,
      process: {
        uid: 42,
        machine: "remote",
        boot: "fixture",
        pid: 100,
        start: "1",
        process_group: 100,
        terminal: "t1",
      },
      log_offset: 0,
      artifacts: [],
      wait: false,
    },
  };
  const chain: Decision = {
    id: "Q-1" as Decision["id"],
    key: "Q-1" as Decision["id"],
    category: "publish",
    card_id,
    kind: "approve",
    target: { subject: { kind: "artifact_sha256", value: unsigned } },
    status: "resolved",
    decider: "human",
    options: [
      {
        key: "release_chain",
        description: `发布链 ${commit} 发布到 https://dl.example.invalid/t/<version>-<sha12>/app.apk`,
        impact: "按链执行",
      },
    ],
    recommended: "release_chain",
    question: "批准发布链？",
    context: "测试",
    raised_by: "human",
    affected_cards: [card_id],
    affected_work_items: [],
    blocking: false,
    doc_refs: [],
    resolution: {
      option: "release_chain",
      rationale: "通过",
      resolved_by: "human",
      via: "needs_you",
      via_chain: [],
      raw_quote: "通过",
      at: NOW,
    },
  };
  const intake: Attachment = {
    id: "attachment-1",
    kind: "artifact",
    basis: chain.id,
    card_id,
    sha256: unsigned,
    size: unsignedBytes.length,
    mime: "application/vnd.android.package-archive",
    uploaded_by: "human",
    storage_path: "",
    attach_to: { kind: "timeline_entry", id: entry },
  };
  store.uow.run((tx) => {
    tx.assignments.put(project_id, {
      ...a,
      runtime_state: "running",
      runtime_ref: ref,
    });
    tx.work_items.put(project_id, {
      ...workItems,
      assignment_id: a.id,
      status: "in_progress",
    });
    tx.cards.put(project_id, { ...serverCard, status: "in_progress" });
    tx.runs.put(project_id, r);
  });
  return {
    store,
    chain,
    intake,
    ctx: { store, identity: caller.value, revalidateToken: vi.fn() },
  };
}
const receipt = {
  status: "signed",
  request_id: rid,
  sha256: signed,
  platform: "android",
  download: { method: "GET", query: "?x", requires_bearer: true },
};
function host(fail = { open: false }) {
  const seen: Buffer[] = [];
  return {
    seen,
    chainSigning: vi.fn(async (_scope, candidate, current: () => void) => {
      current();
      const chunks: Buffer[] = [];
      for await (const c of await candidate.source()) chunks.push(c as Buffer);
      seen.push(Buffer.concat(chunks));
      expect(candidate).toMatchObject({
        commit,
        sha256: unsigned,
        size: unsignedBytes.length,
        build: "attachment-1",
      });
      return { request_id: rid, status: "new" as const };
    }),
    signMobile: vi.fn(async () => receipt),
    openMobileArtifact: vi.fn(async () => {
      if (fail.open) throw new Error("not yet");
      return {
        size: signedBytes.length,
        sha256: signed,
        stream: Readable.from([signedBytes]),
      };
    }),
    attachmentStore: {
      put: async () => ({ storage_path: "" }),
      get: async (d: string) => (d === unsigned ? unsignedBytes : undefined),
    },
  };
}

test("an approved chain registers this Run's candidate once, binds the signed digest and stores the signed APK", async () => {
  const { store, chain, intake, ctx } = signingRun();
  try {
    store.uow.run((tx) => {
      tx.decisions.put(project_id, chain);
      tx.attachments.put(project_id, intake);
    });
    const fail = { open: true };
    const h = host(fail);
    const tool = mobileSigningTool({ ...h, dataDir });
    const call = () => tool.handler({ platform: "android" }, ctx);
    await expect(call()).resolves.toMatchObject({
      status: "signed",
      release_chain: { decision_id: "Q-1", signed_intake: "retry" },
    });
    expect(h.seen).toEqual([unsignedBytes]);
    fail.open = false;
    const done = (await call()) as {
      release_chain: { signed_attachment_id: string };
    };
    expect(done.release_chain.signed_attachment_id).toMatch(/^attachment-/u);
    const again = (await call()) as typeof done;
    expect(again.release_chain.signed_attachment_id).toBe(
      done.release_chain.signed_attachment_id,
    );
    // Registered once for this Run; the next polls reuse the recorded grant.
    expect(h.chainSigning).toHaveBeenCalledOnce();
    expect(h.openMobileArtifact).toHaveBeenCalledTimes(2);
    const { events, stored } = store.uow.read((tx) => ({
      events: tx.events.listAfter(project_id, card_id, 0),
      stored: tx.attachments.get(
        project_id,
        done.release_chain.signed_attachment_id as Attachment["id"],
      ),
    }));
    expect(stored).toMatchObject({
      kind: "artifact",
      basis: "Q-1",
      sha256: signed,
      size: signedBytes.length,
    });
    const types = events.map((e) => e.type);
    expect(
      types.filter((t) => t === "release_chain_signing_approved"),
    ).toHaveLength(1);
    expect(types.filter((t) => t === "release_chain_signed")).toHaveLength(1);
    expect(
      events
        .filter((e) => e.type.startsWith("release_chain_"))
        .every((e) => e.actor.kind === "system"),
    ).toBe(true);
    // The stored signed APK is exactly what the chain may publish.
    expect(
      stored &&
        approvesPublication(project_id, stored, chain, undefined, [], events),
    ).toBe(true);
  } finally {
    store.close();
  }
});

test("without an approved chain, or with another grant on the Run, signing is unchanged", async () => {
  const { store, chain, intake, ctx } = signingRun();
  try {
    const h = host();
    const tool = mobileSigningTool({ ...h, dataDir });
    const call = () => tool.handler({ platform: "android" }, ctx);
    store.uow.run((tx) => tx.attachments.put(project_id, intake));
    await expect(call()).resolves.toEqual(receipt);
    store.uow.run((tx) =>
      tx.decisions.put(project_id, {
        ...chain,
        resolution: { ...(chain.resolution as never), option: "reject" },
      }),
    );
    await expect(call()).resolves.toEqual(receipt);
    expect(h.chainSigning).not.toHaveBeenCalled();
    store.uow.run((tx) => tx.decisions.put(project_id, chain));
    h.chainSigning.mockResolvedValueOnce({ request_id: rid, status: "other" });
    await expect(call()).resolves.toEqual(receipt);
    h.chainSigning.mockRejectedValueOnce(new Error("host down"));
    await expect(call()).resolves.toEqual(receipt);
    await expect(tool.handler({ platform: "ios" }, ctx)).resolves.toEqual(
      receipt,
    );
    expect(h.chainSigning).toHaveBeenCalledTimes(2);
    expect(h.openMobileArtifact).not.toHaveBeenCalled();
    const events = store.uow.read((tx) =>
      tx.events.listAfter(project_id, card_id, 0),
    );
    expect(events.some((e) => e.type.startsWith("release_chain_"))).toBe(false);
  } finally {
    store.close();
  }
});
