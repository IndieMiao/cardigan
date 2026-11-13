import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import {
  request as httpRequest,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { join } from "node:path";
import { Readable } from "node:stream";
import {
  type Card,
  type Decision,
  listNeedsYou,
  pauseStandingAssignment,
  pmFailedMergeCheck,
  recordMergeCheck,
  releaseAssignment,
  requestDecision,
  requestHumanAction,
  requestWorktreeCleanup,
} from "@cardigan/domain";
import { parseLaunchConfig } from "@cardigan/roles";
import { routeEvent } from "@cardigan/router";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { type M4Cross, m4Cross } from "../../test-support/m4-cross.js";
import { Dispatcher } from "../dispatch.js";
import { startQueuedRun } from "../host-start.js";
import { resolveWebConfig } from "./config.js";
import { HttpRejection } from "./http.js";
import { type RunningWebServer, startWebServer } from "./server.js";
import { serveWrite } from "./write.js";

let s: M4Cross, web: RunningWebServer, cookie: string;
const password = "workbench test password";
const question = {
  category: "scope_change" as const,
  kind: "choose" as const,
  question: "Choose",
  context: "Need direction",
  options: [{ key: "go", description: "Go", impact: "Unblocks" }],
  recommended: "go",
  affected_cards: [],
  affected_work_items: [],
  blocking: false,
  decider: "human" as const,
};
const path = (rest: string) => `/api/projects/${s.project.project_id}${rest}`;
async function request(
  rest: string,
  body: unknown,
  headers: Record<string, string> = {},
) {
  const response = await fetch(web.url + path(rest), {
    method: "POST",
    headers: {
      cookie,
      origin: web.url,
      "content-type": "application/json",
      ...headers,
    },
    body: JSON.stringify(body),
  });
  return {
    status: response.status,
    body: (await response.json()) as Record<string, unknown>,
  };
}
const cardPath = (op: string) => `/cards/${s.card.id}/${op}`;
const resolvePath = (q: Decision) =>
  `/decisions/${encodeURIComponent(q.id)}/resolve`;
const snapshot = () => JSON.stringify(s.state());
beforeEach(async () => {
  s = await m4Cross();
  s.store().setWebPassword(password);
  web = await startWebServer({
    store: s.store(),
    dataDir: s.dataDir,
    config: resolveWebConfig({}, { port: 0, staticDir: s.root }),
  });
  const login = await fetch(`${web.url}/api/login`, {
    method: "POST",
    headers: { origin: web.url, "content-type": "application/json" },
    body: JSON.stringify({ password }),
  });
  cookie = (login.headers.get("set-cookie") ?? "").split(";")[0] as string;
  expect(login.status).toBe(200);
  await login.body?.cancel();
});
afterEach(async () => {
  await web?.close();
  await s?.close();
}, 30_000);

test("human card updates set and clear risk tags and reject invalid values atomically", async () => {
  const risk_tags = ["security", "permission", "numeric_rule"];
  expect(await request(cardPath("update"), { risk_tags })).toMatchObject({
    status: 200,
  });
  expect(s.state().cards.find((c) => c.id === s.card.id)?.risk_tags).toEqual(
    risk_tags,
  );
  const before = snapshot();
  for (const invalid of [["spending"], "security", null])
    expect(
      await request(cardPath("update"), { risk_tags: invalid }),
    ).toMatchObject({ status: 400 });
  expect(snapshot()).toBe(before);
  expect(await request(cardPath("update"), { risk_tags: [] })).toMatchObject({
    status: 200,
  });
  expect(s.state().cards.find((c) => c.id === s.card.id)?.risk_tags).toEqual(
    [],
  );
});

test("human comments preserve Markdown, mentions and resolved reference metadata", async () => {
  const body = `    code\n\n见 ${s.card.id} ${s.primary.owner.work_item_id} C-999`;
  const response = await request(cardPath("comments"), {
    body,
    mentions: [`@${s.primary.owner.id}`],
    author: "assignment:forged",
  });
  expect(response).toMatchObject({
    status: 200,
    body: {
      type: "comment",
      body,
      author: "human",
      mentions: [`@${s.primary.owner.id}`],
    },
  });
  const read = await fetch(web.url + path(`/cards/${s.card.id}`), {
    headers: { cookie },
  });
  const detail = (await read.json()) as {
    timeline: { id: string; references: unknown[] }[];
  };
  expect(
    detail.timeline.find((e) => e.id === response.body.id)?.references,
  ).toContainEqual({ kind: "card", id: "C-999", status: null, exists: false });
  expect(
    detail.timeline.find((e) => e.id === response.body.id)?.references,
  ).toContainEqual(
    expect.objectContaining({
      kind: "work_item",
      exists: true,
      card_id: s.card.id,
    }),
  );
  const before = snapshot();
  expect(await request(cardPath("comments"), { body: " " })).toMatchObject({
    status: 400,
    body: { error: { code: "validation_failed" } },
  });
  expect(snapshot()).toBe(before);
});

test("human instruction commits one typed event and rejects a closed card without partial writes", async () => {
  const p = {
    work_item_id: s.primary.owner.work_item_id,
    body: "Please implement",
  };
  expect(await request(cardPath("instructions"), p)).toMatchObject({
    status: 200,
    body: { author: "human", type: "instruction" },
  });
  expect(
    s.state().events.filter((e) => e.type === "instruction_issued"),
  ).toHaveLength(1);
  s.cancel();
  const before = snapshot();
  expect(await request(cardPath("instructions"), p)).toMatchObject({
    status: 409,
    body: { error: { code: "illegal_transition" } },
  });
  expect(snapshot()).toBe(before);
});

test("Needs You decisions preserve a human quote, supply a default, and reject wrong deciders or options", async () => {
  const q = s.command((state, actor, ports) =>
    requestDecision(state, actor, { ...question, card_id: s.card.id }, ports),
  );
  let before = snapshot();
  expect(await request(resolvePath(q), { option: "absent" })).toMatchObject({
    status: 400,
    body: { error: { code: "validation_failed" } },
  });
  expect(snapshot()).toBe(before);
  const payload = { option: "go", raw_quote: "  选 go  " };
  const headers = { "Idempotency-Key": "resolve-once" };
  const resolved = await request(resolvePath(q), payload, headers);
  const committed = snapshot();
  expect(await request(resolvePath(q), payload, headers)).toEqual(resolved);
  expect(snapshot()).toBe(committed);
  expect(resolved).toMatchObject({
    status: 200,
    body: {
      resolution: {
        via: "needs_you",
        resolved_by: "human",
        raw_quote: "  选 go  ",
      },
    },
  });
  const project = s.command((state, actor, ports) =>
    requestDecision(state, actor, question, ports),
  );
  expect(
    await request(resolvePath(project), { option: "go", raw_quote: "" }),
  ).toMatchObject({
    status: 200,
    body: { resolution: { raw_quote: "在 Needs You 选择了 go" } },
  });
  const role = s.command((state, actor, ports) =>
    requestDecision(
      state,
      actor,
      { ...question, category: "general", decider: "role:reviewer" },
      ports,
    ),
  );
  before = snapshot();
  expect(await request(resolvePath(role), { option: "go" })).toMatchObject({
    status: 403,
    body: { error: { code: "forbidden_tool" } },
  });
  expect(snapshot()).toBe(before);
});

test("human action completion validates result, completes once, and rejects a terminal replay", async () => {
  const action = s.command((state, actor, ports) =>
    requestHumanAction(
      state,
      actor,
      {
        card_id: s.card.id,
        instructions: "Connect",
        why_human: "Device",
        expected_return: "Ready",
        blocked_work_items: [],
      },
      ports,
    ),
  );
  const url = `/human-actions/${encodeURIComponent(action.id)}/complete`,
    before = snapshot();
  expect(await request(url, { text: "" })).toMatchObject({ status: 400 });
  expect(snapshot()).toBe(before);
  const payload = { text: "Connected", attachments: [] };
  const headers = { "Idempotency-Key": "complete-once" };
  const completed = await request(url, payload, headers);
  const committed = snapshot();
  expect(await request(url, payload, headers)).toEqual(completed);
  expect(snapshot()).toBe(committed);
  expect(completed).toMatchObject({
    status: 200,
    body: { status: "done", result: { text: "Connected" } },
  });
  expect(await request(url, { text: "Connected" })).toMatchObject({
    status: 409,
    body: { error: { code: "illegal_transition" } },
  });
});

test("merge confirmation uses the same human decision path and unlocks the accepted merge plan", async () => {
  const d = await s.deliver(
    s.primary,
    await s.change(s.primary.owner, "feature.txt", "done\n"),
  );
  await s.review(s.primary.verifier, d);
  await s.complete(d);
  const q = s.state().decisions.find((q) => q.trigger === "merge_confirmation");
  if (!q) throw new Error("No confirmation");
  expect(await request(resolvePath(q), { option: "absent" })).toMatchObject({
    status: 400,
  });
  expect(await request(resolvePath(q), { option: "merge" })).toMatchObject({
    status: 200,
    body: { resolution: { via: "needs_you" } },
  });
  expect(s.plan().deliveries.map((d) => d.delivery_id)).toContain(d.id);
});

test.each(
  (["failed", "timed_out"] as const).flatMap((status) =>
    [false, true].map((enabled) => ({ status, enabled })),
  ),
)(
  "Workbench returns a confirmed $status merge with PM delegation enabled=$enabled",
  async ({ status, enabled }) => {
    const delivery = await s.deliver(
      s.primary,
      await s.change(s.primary.owner, "feature.txt", "done\n"),
    );
    await s.review(s.primary.verifier, delivery);
    await s.complete(delivery);
    const q = s
      .state()
      .decisions.find((q) => q.trigger === "merge_confirmation");
    if (!q) throw new Error("No confirmation");
    expect(await request(resolvePath(q), { option: "merge" })).toMatchObject({
      status: 200,
    });
    expect(
      await request(
        "/preferences",
        {
          pm_merge_confirmation: enabled,
        },
        { "Idempotency-Key": "set-merge-delegation" },
      ),
    ).toMatchObject({ status: 200 });
    const identity = {
      card_id: s.card.id,
      completion_id: s.plan().completion_id,
      attempt_id: "web-check",
      candidate_sha: "a".repeat(40),
      tree_sha: "b".repeat(40),
    };
    const returning = { option: "request_changes", raw_quote: "修复检查失败" };
    for (const checkStatus of ["queued", "running", status] as const) {
      s.command((state, _actor, ports) =>
        recordMergeCheck(
          { ...state, project_settings: { merge_gate_enabled: true } },
          { kind: "system", project_id: state.project_id },
          checkStatus === "queued" || checkStatus === "running"
            ? { ...identity, status: checkStatus }
            : {
                ...identity,
                status: checkStatus,
                checks: [],
                summary: "检查失败",
                log_ref: "web-check.log",
              },
          ports,
        ),
      );
      if (checkStatus === "queued" || checkStatus === "running") {
        const before = snapshot();
        expect(await request(resolvePath(q), returning)).toMatchObject({
          status: 409,
          body: {
            error: { message: expect.stringContaining("最新检查失败或超时") },
          },
        });
        expect(snapshot()).toBe(before);
      }
    }
    // C-79: current preferences decide who handles the failed confirmation.
    const confirmed = s.state().decisions.find((d) => d.id === q.id);
    if (!confirmed) throw new Error("No confirmation");
    if (enabled)
      expect(pmFailedMergeCheck(s.state(), confirmed)).toMatchObject({
        status,
      });
    else expect(pmFailedMergeCheck(s.state(), confirmed)).toBeUndefined();
    const needs = await fetch(web.url + path("/needs-you"), {
      headers: { cookie },
    });
    const needsBody = await needs.json();
    expect(needsBody.decisions.some((d: { id: string }) => d.id === q.id)).toBe(
      !enabled,
    );
    // Without an active PM Ops the human still gets the C-46 return entry.
    const human = { kind: "human", project_id: s.state().project_id } as const;
    const withoutOps = {
      ...s.state(),
      assignments: s
        .state()
        .assignments.filter(
          (a) => !(a.scope === "standing" && a.standing_mode === "ops"),
        ),
    };
    const pending = listNeedsYou(withoutOps, human);
    if (!pending.ok) throw pending.error;
    expect(pending.value.data.decisions).toEqual([
      expect.objectContaining({
        id: q.id,
        status: "resolved",
        options: [expect.objectContaining({ key: "request_changes" })],
      }),
    ]);
    expect(pending.value.data.decisions[0]?.followup_notice).toBeUndefined();
    // The human can still return it directly through the Workbench.
    const headers = { "Idempotency-Key": "return-failed-merge" };
    const response = await request(resolvePath(q), returning, headers);
    expect(response).toMatchObject({
      status: 200,
      body: { status: "superseded", resolution: { option: "merge" } },
    });
    const committed = snapshot();
    expect(await request(resolvePath(q), returning, headers)).toEqual(response);
    expect(snapshot()).toBe(committed);
    expect(s.state().cards.find((c) => c.id === s.card.id)?.status).toBe(
      "in_progress",
    );
    expect(
      s.state().events.findLast((e) => e.type === "merge_changes_requested")
        ?.payload,
    ).toMatchObject({
      reason: returning.raw_quote,
      run_kind: "fix",
      completion_id: identity.completion_id,
    });
  },
);

test.each(["keep", "force_clean"])(
  "cleanup choice %s records the decision and leaves deletion to the executor",
  async (option) => {
    await s.start(s.primary.owner);
    await s.finish(s.primary.owner);
    s.release(s.primary.owner);
    const q = s.command((state, _actor, ports) =>
      requestWorktreeCleanup(
        state,
        { kind: "system", project_id: state.project_id },
        { assignment_id: s.primary.owner.id, reason: "Uncommitted work" },
        ports,
      ),
    );
    expect(await request(resolvePath(q), { option: "invalid" })).toMatchObject({
      status: 400,
    });
    expect(await request(resolvePath(q), { option })).toMatchObject({
      status: 200,
      body: { resolution: { option, via: "needs_you" } },
    });
    expect(existsSync(s.path(s.primary.owner))).toBe(true);
  },
);

test.each(["request_information", "explain"])(
  "decision %s posts a comment mentioning the actual recipient",
  async (action) => {
    await s.start(s.primary.owner);
    const q = await s.call<Decision>(s.primary.owner, "request_decision", {
      ...question,
      card_id: s.card.id,
    });
    const url = `/decisions/${encodeURIComponent(q.id)}/comments`;
    const target =
      action === "explain"
        ? s.state().assignments.find((a) => a.standing_mode === "office")?.id
        : s.primary.owner.id;
    expect(await request(url, { action })).toMatchObject({
      status: 200,
      body: {
        type: "comment",
        author: "human",
        mentions: [`@${target}`],
        refs: [{ kind: "decision", id: q.id }],
      },
    });
    expect(await request(url, { action: "invalid" })).toMatchObject({
      status: 400,
    });
    const project = s.command((state, actor, ports) =>
      requestDecision(state, actor, question, ports),
    );
    expect(
      await request(`/decisions/${encodeURIComponent(project.id)}/comments`, {
        action,
      }),
    ).toMatchObject({
      status: 400,
      body: { error: { code: "validation_failed" } },
    });
  },
);

test("attachment upload shares MCP storage, verifies digest and retains an unreferenced blob on transaction rejection", async () => {
  const comment = await request(cardPath("comments"), { body: "Screenshot" });
  const file = Buffer.from("fixture evidence"),
    digest = createHash("sha256").update(file).digest("hex");
  const p = {
    file: file.toString("base64"),
    original_filename: "/browser/证据.txt",
    note: "测试结果",
    mime: "text/plain",
    kind: "evidence",
    attach_to: { kind: "timeline_entry", id: comment.body.id },
    sha256: digest,
  };
  const before = snapshot();
  expect(
    await request(cardPath("attachments"), { ...p, sha256: "0".repeat(64) }),
  ).toMatchObject({ status: 400 });
  expect(snapshot()).toBe(before);
  const headers = { "Idempotency-Key": "upload-once" };
  const uploaded = await request(cardPath("attachments"), p, headers);
  const committed = snapshot();
  expect(await request(cardPath("attachments"), p, headers)).toEqual(uploaded);
  expect(snapshot()).toBe(committed);
  expect(uploaded).toMatchObject({
    status: 200,
    body: {
      sha256: digest,
      uploaded_by: "human",
      original_filename: "证据.txt",
      note: "测试结果",
      storage_path: `attachments/${digest}`,
    },
  });
  const detail = await fetch(web.url + path(`/cards/${s.card.id}`), {
    headers: { cookie },
  });
  expect((await detail.json()).attachments).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        id: uploaded.body.id,
        original_filename: "证据.txt",
        note: "测试结果",
      }),
    ]),
  );
  const stored = join(s.dataDir, "attachments", digest);
  expect(readFileSync(stored)).toEqual(file);
  expect(statSync(stored).mode & 0o777).toBe(0o600);
  const downloaded = await fetch(
    web.url + path(`/attachments/${uploaded.body.id}`),
    { headers: { cookie } },
  );
  expect(Buffer.from(await downloaded.arrayBuffer())).toEqual(file);
  const other = Buffer.from("pending artifact"),
    otherDigest = createHash("sha256").update(other).digest("hex"),
    previous = snapshot();
  expect(
    await request(cardPath("attachments"), {
      ...p,
      file: other.toString("base64"),
      sha256: otherDigest,
      kind: "artifact",
    }),
  ).toMatchObject({
    status: 400,
    body: { error: { code: "validation_failed" } },
  });
  expect(snapshot()).toBe(previous);
  expect(readFileSync(join(s.dataDir, "attachments", otherDigest))).toEqual(
    other,
  );
});

test("attachment metadata is optional and rejects invalid names and notes without records", async () => {
  const comment = await request(cardPath("comments"), { body: "Target" });
  const p = {
    file: Buffer.from("metadata").toString("base64"),
    mime: "text/plain",
    kind: "evidence",
    attach_to: { kind: "timeline_entry", id: comment.body.id },
  };
  const before = snapshot();
  for (const metadata of [
    { original_filename: "a".repeat(201) },
    { original_filename: "bad\0.txt" },
    { note: "a".repeat(201) },
    { note: "line\nline" },
  ]) {
    expect(
      await request(cardPath("attachments"), { ...p, ...metadata }),
    ).toMatchObject({
      status: 400,
      body: { error: { code: "validation_failed" } },
    });
    expect(snapshot()).toBe(before);
  }
  const legacy = await request(cardPath("attachments"), p);
  expect(legacy.status).toBe(200);
  expect(legacy.body).not.toHaveProperty("original_filename");
  expect(legacy.body).not.toHaveProperty("note");
});

test("attachment boundary rejects noncanonical base64 and files over 10 MiB", async () => {
  const comment = await request(cardPath("comments"), { body: "Target" }),
    before = snapshot();
  for (const file of [
    "not-base64!",
    Buffer.alloc(10 * 1024 * 1024 + 1).toString("base64"),
  ]) {
    expect(
      await request(cardPath("attachments"), {
        file,
        mime: "text/plain",
        kind: "evidence",
        attach_to: { kind: "timeline_entry", id: comment.body.id },
      }),
    ).toMatchObject({
      status: 400,
      body: { error: { code: "validation_failed" } },
    });
    expect(snapshot()).toBe(before);
  }
}, 30_000);

test("every write route enforces cookie authentication, Origin and JSON before any mutation", async () => {
  const routes = [
      cardPath("comments"),
      cardPath("instructions"),
      cardPath("attachments"),
      cardPath("update"),
      cardPath("cancel"),
      cardPath("supersede"),
      "/decisions/Q-1/resolve",
      "/decisions/Q-1/comments",
      "/human-actions/H-1/complete",
    ],
    before = snapshot();
  for (const url of routes) {
    expect(
      await request(url, {}, { cookie: "", authorization: "Bearer ignored" }),
    ).toMatchObject({ status: 401 });
    expect(
      await request(url, {}, { origin: "https://foreign.invalid" }),
    ).toMatchObject({
      status: 403,
      body: { error: { code: "origin_rejected" } },
    });
    expect(
      await request(url, {}, { "content-type": "text/plain" }),
    ).toMatchObject({ status: 415 });
  }
  expect(snapshot()).toBe(before);
});

test("write handler authenticates before touching an upload body", async () => {
  let read = false;
  const req = Object.assign(
    Readable.from(
      (async function* () {
        read = true;
        yield "{}";
      })(),
    ),
    { method: "POST", headers: { "content-type": "application/json" } },
  ) as unknown as IncomingMessage;
  await expect(
    serveWrite(
      {
        req,
        res: {} as ServerResponse,
        store: s.store(),
        project_id: s.project.project_id,
        dataDir: s.dataDir,
        clock: { now: () => new Date().toISOString() },
        authorize: () => {
          throw new HttpRejection(401, "unauthorized", "login required");
        },
      },
      cardPath("attachments"),
    ),
  ).rejects.toMatchObject({ status: 401 });
  expect(read).toBe(false);
  req.destroy();
});

test("unauthenticated large upload receives 401 before the request body finishes", async () => {
  let client: ReturnType<typeof httpRequest> | undefined;
  try {
    const status = await new Promise<number | undefined>((resolve, reject) => {
      client = httpRequest(
        web.url + path(cardPath("attachments")),
        {
          method: "POST",
          headers: {
            origin: web.url,
            "content-type": "application/json",
            "content-length": 14 * 1024 * 1024,
          },
        },
        (response) => {
          response.resume();
          response.on("end", () => resolve(response.statusCode));
        },
      );
      client.on("error", reject);
      client.setTimeout(3000, () =>
        client?.destroy(new Error("Server waited for the upload")),
      );
      client.write("{"); // Deliberately never end the declared 14 MiB body.
    });
    expect(status).toBe(401);
    expect(client?.writableFinished).toBe(false);
  } finally {
    client?.destroy();
  }
});

test("Needs You exposes risk category and cleanup Assignment for the UI", async () => {
  await s.start(s.primary.owner);
  await s.finish(s.primary.owner);
  s.release(s.primary.owner);
  const q = s.command((state, _actor, ports) =>
    requestWorktreeCleanup(
      state,
      { kind: "system", project_id: state.project_id },
      { assignment_id: s.primary.owner.id, reason: "Dirty workspace" },
      ports,
    ),
  );
  const response = await fetch(web.url + path("/needs-you"), {
    headers: { cookie },
  });
  expect(await response.json()).toMatchObject({
    decisions: [
      expect.objectContaining({
        id: q.id,
        category: "data_deletion",
        assignment_id: s.primary.owner.id,
      }),
    ],
    incidents: [],
  });
});

test("execution exposes the card and persistent PM mode without credential metadata", async () => {
  const response = await fetch(web.url + path("/execution"), {
    headers: { cookie },
  });
  const data = (await response.json()) as {
    assignments: Record<string, unknown>[];
  };
  expect(data.assignments).toContainEqual(
    expect.objectContaining({
      id: s.primary.owner.id,
      card_id: s.card.id,
      card_status: "todo",
    }),
  );
  expect(data.assignments).toContainEqual(
    expect.objectContaining({ role_id: "pm", standing_mode: "office" }),
  );
  expect(data.assignments).toContainEqual(
    expect.objectContaining({ role_id: "pm", standing_mode: "ops" }),
  );
  for (const a of data.assignments)
    expect(a).not.toHaveProperty("mcp_token_id");
});

test("activity exposes event payloads so the UI can explain instructions and decisions", async () => {
  await request(cardPath("comments"), { body: "先检查再发布" });
  const response = await fetch(
    web.url + path("/activity?type=comment_posted"),
    { headers: { cookie } },
  );
  expect(await response.json()).toMatchObject({
    events: [
      expect.objectContaining({
        type: "comment_posted",
        role: "human",
        payload: { body: "先检查再发布" },
      }),
    ],
  });
});

test("concurrent retries return the original comment and commit only one event", async () => {
  const payload = { body: "只发一次", mentions: [] };
  const headers = { "Idempotency-Key": "comment-once" };
  const before = s.state();
  const [first, retry] = await Promise.all([
    request(cardPath("comments"), payload, headers),
    request(cardPath("comments"), payload, headers),
  ]);
  expect(first.status).toBe(200);
  expect(retry).toEqual(first);
  expect(s.state().timeline.length - before.timeline.length).toBe(1);
  expect(s.state().events.length - before.events.length).toBe(1);
  const after = snapshot();
  // JSON key order is irrelevant; subsequent state changes do not alter the receipt.
  s.cancel();
  expect(
    await request(
      cardPath("comments"),
      { mentions: [], body: payload.body },
      headers,
    ),
  ).toEqual(first);
  expect(
    s.state().timeline.filter((entry) => entry.body === payload.body),
  ).toHaveLength(1);
  expect(after).not.toBe(snapshot());
});

test("same-key content or route conflicts return a Chinese 409 without changes", async () => {
  const headers = { "Idempotency-Key": "conflict" };
  const payload = { body: "原文", work_item_id: s.primary.owner.work_item_id };
  const first = await request(cardPath("comments"), payload, headers);
  expect(first.status).toBe(200);
  const before = snapshot();
  for (const [url, body] of [
    [cardPath("comments"), { ...payload, body: "修改过的正文" }],
    [cardPath("instructions"), payload],
  ] as const) {
    expect(await request(url, body, headers)).toMatchObject({
      status: 409,
      body: {
        error: {
          code: "idempotency_conflict",
          message: expect.stringContaining("不同的请求内容"),
        },
      },
    });
  }
  expect(snapshot()).toBe(before);
  expect(await request(cardPath("comments"), payload, headers)).toEqual(first);
});

test("legacy comments without a key still execute on every request", async () => {
  const before = s.state();
  const first = await request(cardPath("comments"), { body: "旧客户端" });
  const second = await request(cardPath("comments"), { body: "旧客户端" });
  expect(first.status).toBe(200);
  expect(second.status).toBe(200);
  expect(first.body.id).not.toBe(second.body.id);
  expect(s.state().timeline.length - before.timeline.length).toBe(2);
  expect(s.state().events.length - before.events.length).toBe(2);
});

test("cached writes still require a live session, valid Origin and JSON", async () => {
  const headers = { "Idempotency-Key": "authenticated-retry" };
  const payload = { body: "需要认证" };
  const first = await request(cardPath("comments"), payload, headers);
  const before = snapshot();
  expect(first.status).toBe(200);
  expect(
    await request(cardPath("comments"), payload, {
      ...headers,
      origin: "https://foreign.invalid",
    }),
  ).toMatchObject({ status: 403 });
  expect(
    await request(cardPath("comments"), payload, {
      ...headers,
      "content-type": "text/plain",
    }),
  ).toMatchObject({ status: 415 });
  // Rotating sessions does not rotate the single human identity.
  const login = await fetch(`${web.url}/api/login`, {
    method: "POST",
    headers: { origin: web.url, "content-type": "application/json" },
    body: JSON.stringify({ password }),
  });
  const secondCookie = (login.headers.get("set-cookie") ?? "").split(
    ";",
  )[0] as string;
  await login.body?.cancel();
  expect(
    await request(cardPath("comments"), payload, {
      ...headers,
      cookie: secondCookie,
    }),
  ).toEqual(first);
  s.store().setWebPassword(password);
  expect(await request(cardPath("comments"), payload, headers)).toMatchObject({
    status: 401,
  });
  expect(snapshot()).toBe(before);
});

test("failed persistence rolls back the effect and leaves the key available", async () => {
  const headers = { "Idempotency-Key": "rollback" };
  const payload = { body: "事务测试" };
  const before = snapshot();
  s.store().database.exec(
    "CREATE TRIGGER reject_receipt BEFORE INSERT ON idempotency BEGIN SELECT RAISE(ABORT, 'receipt failure'); END",
  );
  expect(await request(cardPath("comments"), payload, headers)).toMatchObject({
    status: 500,
  });
  expect(snapshot()).toBe(before);
  s.store().database.exec("DROP TRIGGER reject_receipt");
  expect(await request(cardPath("comments"), payload, headers)).toMatchObject({
    status: 200,
  });
});

test("human receipts expire after 24 hours without expiring MCP or other projects", async () => {
  const store = s.store(),
    key = "retained-key";
  const params = { project_id: s.project.project_id, key, request: {} };
  expect(
    store.runIdempotent(
      { ...params, assignment_id: s.primary.owner.id },
      () => "MCP",
    ).ok,
  ).toBe(true);
  expect(
    store.runHumanIdempotent(
      { ...params, project_id: "other-project" },
      () => "other",
    ).ok,
  ).toBe(true);
  const headers = { "Idempotency-Key": key },
    payload = { body: "一天内重试" };
  const first = await request(cardPath("comments"), payload, headers);
  expect(first.status).toBe(200);
  store.database
    .prepare("UPDATE idempotency SET created_at = ?")
    .run(new Date(Date.now() - 23 * 60 * 60 * 1000).toISOString());
  expect(await request(cardPath("comments"), payload, headers)).toEqual(first);
  store.database
    .prepare("UPDATE idempotency SET created_at = ?")
    .run(new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString());
  const next = await request(cardPath("comments"), payload, headers);
  expect(next.status).toBe(200);
  expect(next.body.id).not.toBe(first.body.id);
  expect(
    store.runIdempotent(
      { ...params, assignment_id: s.primary.owner.id },
      () => "wrong",
    ),
  ).toMatchObject({ ok: true, value: { value: "MCP", replayed: true } });
  expect(
    store.database
      .prepare("SELECT response FROM idempotency WHERE project_id = ?")
      .get("other-project")?.response,
  ).toBe('"other"');
});

test("invalid keys are rejected and validation failures do not consume a key", async () => {
  const before = snapshot();
  for (const key of ["", " ", "k".repeat(257)]) {
    expect(
      await request(
        cardPath("comments"),
        { body: "test" },
        { "Idempotency-Key": key },
      ),
    ).toMatchObject({ status: 400 });
  }
  const headers = { "Idempotency-Key": "correctable" };
  expect(
    await request(cardPath("comments"), { body: "" }, headers),
  ).toMatchObject({ status: 400 });
  expect(snapshot()).toBe(before);
  expect(
    await request(cardPath("comments"), { body: "修正正文" }, headers),
  ).toMatchObject({ status: 200 });
});

test("K2 updates every field as human and replays without overwriting later changes", async () => {
  const payload = {
    title: "新标题",
    goal: "新目标",
    acceptance_criteria: ["第一条", "第二条", "新增一条"],
    priority: 3,
  };
  const headers = { "Idempotency-Key": "card-edit" };
  const first = await request(cardPath("update"), payload, headers);
  expect(first).toMatchObject({ status: 200, body: payload });
  expect(s.state().events.at(-1)).toMatchObject({
    type: "card_updated",
    actor: { kind: "human" },
  });
  const removed = { acceptance_criteria: ["修改后的唯一一条"] };
  expect(await request(cardPath("update"), removed)).toMatchObject({
    status: 200,
    body: removed,
  });
  const before = snapshot();
  expect(await request(cardPath("update"), payload, headers)).toEqual(first);
  expect(
    await request(cardPath("update"), { title: "冲突" }, headers),
  ).toMatchObject({
    status: 409,
    body: { error: { code: "idempotency_conflict" } },
  });
  expect(snapshot()).toBe(before);
  expect(s.state().cards.find((card) => card.id === s.card.id)).toMatchObject(
    removed,
  );
});

test("K2 rejects empty fields and manual progress without partial changes", async () => {
  const before = snapshot();
  for (const payload of [
    {},
    { title: " " },
    { goal: "" },
    { acceptance_criteria: [] },
    { acceptance_criteria: [""] },
    { priority: "high" },
    { title: "valid", status: "done" },
  ]) {
    expect(await request(cardPath("update"), payload)).toMatchObject({
      status: 400,
    });
    expect(snapshot()).toBe(before);
  }
});

test.each([undefined, "", "不再需要这个目标"])(
  "K2 cancellation records its optional reason once (%s)",
  async (reason) => {
    // A passed verifier survives cancellation; other work follows the domain transition.
    s.store().uow.run((tx) => {
      const workItemId = s.primary.verifier.work_item_id;
      if (!workItemId) throw new Error("Missing verifier work item");
      const item = tx.work_items.get(s.project.project_id, workItemId);
      if (!item) throw new Error("Missing verifier");
      tx.work_items.put(s.project.project_id, { ...item, status: "passed" });
    });
    const payload = reason === undefined ? {} : { reason };
    const headers = { "Idempotency-Key": "cancel-once" };
    const before = s.state();
    const first = await request(cardPath("cancel"), payload, headers);
    expect(first).toMatchObject({ status: 200, body: { status: "cancelled" } });
    const committed = snapshot();
    expect(await request(cardPath("cancel"), payload, headers)).toEqual(first);
    expect(snapshot()).toBe(committed);
    expect(
      s
        .state()
        .work_items.filter((item) => item.card_id === s.card.id)
        .every((item) =>
          item.id === s.primary.verifier.work_item_id
            ? item.status === "passed"
            : item.status === "cancelled",
        ),
    ).toBe(true);
    const timeline = s.state().timeline.slice(before.timeline.length);
    expect(timeline).toHaveLength(reason ? 2 : 1);
    if (reason)
      expect(timeline).toContainEqual(
        expect.objectContaining({
          type: "comment",
          author: "human",
          body: `取消卡片原因：${reason}`,
        }),
      );
  },
);

test("K2 cancelled card and explanation roll back together, leaving the retry key usable", async () => {
  const before = snapshot();
  const headers = { "Idempotency-Key": "cancel-rollback" };
  const payload = { reason: "需同时保存" };
  s.store().database.exec(
    "CREATE TRIGGER reject_cancel_reason BEFORE INSERT ON timeline WHEN json_extract(NEW.doc, '$.type') = 'comment' BEGIN SELECT RAISE(ABORT, 'reason failure'); END",
  );
  expect(await request(cardPath("cancel"), payload, headers)).toMatchObject({
    status: 500,
  });
  expect(snapshot()).toBe(before);
  s.store().database.exec("DROP TRIGGER reject_cancel_reason");
  expect(await request(cardPath("cancel"), payload, headers)).toMatchObject({
    status: 200,
  });
});

test("K2 refuses cancellation of done cards in Chinese and suggests superseding", async () => {
  s.store().uow.run((tx) =>
    tx.cards.put(s.project.project_id, {
      ...s.card,
      status: "done",
      resolution: "done",
    }),
  );
  const before = snapshot();
  expect(
    await request(cardPath("cancel"), { reason: "已完成后尝试" }),
  ).toMatchObject({
    status: 409,
    body: {
      error: {
        code: "illegal_transition",
        message: "已完成卡片不能取消；请建新卡，再把旧卡标记为被取代。",
      },
    },
  });
  expect(snapshot()).toBe(before);
});

test.each(["done", "cancelled"] as const)(
  "K2 supersedes a %s card with a same-project card, preserving status and work",
  async (status) => {
    s.store().uow.run((tx) => {
      tx.cards.put(s.project.project_id, { ...s.card, status });
      tx.cards.put(s.project.project_id, {
        ...s.card,
        id: "C-98" as Card["id"],
      });
      tx.cards.put("other-project", {
        ...s.card,
        project_id: "other-project",
        id: "C-99" as Card["id"],
      });
    });
    const before = snapshot();
    for (const target of [s.card.id, "C-99", "C-100", "other-project/C-98"]) {
      const response = await request(cardPath("supersede"), {
        superseded_by: target,
      });
      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(snapshot()).toBe(before);
    }
    const work = s.state().work_items;
    const payload = { superseded_by: "C-98" };
    const headers = { "Idempotency-Key": "supersede-once" };
    const first = await request(cardPath("supersede"), payload, headers);
    expect(first).toMatchObject({
      status: 200,
      body: {
        ...payload,
        resolution: "superseded",
        status,
        related_cards: expect.arrayContaining(["C-98"]),
      },
    });
    expect(s.state().work_items).toEqual(work);
    expect(s.state().timeline.at(-1)).toMatchObject({
      body: "已被 C-98 取代",
      author: "human",
    });
    const committed = snapshot();
    expect(await request(cardPath("supersede"), payload, headers)).toEqual(
      first,
    );
    expect(snapshot()).toBe(committed);
  },
);

test("K2 cannot supersede an unfinished card", async () => {
  const before = snapshot();
  expect(
    await request(cardPath("supersede"), { superseded_by: "C-98" }),
  ).toMatchObject({
    status: 409,
    body: { error: { message: "只有已完成或已取消的卡片才能标记为被取代。" } },
  });
  expect(snapshot()).toBe(before);
});

test("Workbench body mentions use the shared parser for IDs, roles and employee names", async () => {
  s.store().uow.run((tx) =>
    tx.employees.put({
      id: "E-1",
      name: "诸葛亮 Mary",
      title: "开发",
      bio: "",
      avatar: null,
      role_id: "coder",
      launch_profile_ref: null,
      status: "active",
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
    }),
  );
  const response = await request(cardPath("comments"), {
    body: `请 @${s.primary.owner.id}、@${s.primary.owner.work_item_id}、@coder 和 @诸葛亮　mARY 检查`,
    mentions: [],
  });
  expect(response).toMatchObject({
    status: 200,
    body: {
      author: "human",
      mentions: [
        `@${s.primary.owner.id}`,
        `@${s.primary.owner.work_item_id}`,
        "@coder",
        "@诸葛亮 Mary",
      ],
    },
  });
});

async function reviewLimit(delegated = false) {
  const reviewer = s.primary.verifier;
  if (!delegated) {
    const ops = s
      .state()
      .assignments.find(
        (a) => a.scope === "standing" && a.standing_mode === "ops",
      );
    if (!ops) throw new Error("Missing PM Ops");
    s.command((state, actor, ports) =>
      pauseStandingAssignment(state, actor, { assignment_id: ops.id }, ports),
    );
  }
  // A one-round budget keeps this fixture small; normal updates only raise it.
  s.store().uow.run((tx) => {
    const item = tx.work_items.get(
      s.project.project_id,
      reviewer.work_item_id as never,
    );
    if (item?.kind !== "verify") throw new Error("Missing verifier");
    tx.work_items.put(s.project.project_id, { ...item, max_review_rounds: 1 });
  });
  const sha = await s.change(s.primary.owner, "limit.txt", "Review me");
  const delivery = await s.deliver(s.primary, sha);
  await s.start(reviewer);
  await s.call(reviewer, "submit_review", {
    delivery_id: delivery.id,
    target_sha: sha,
    kind: "code",
    issues: [],
    recheck_required: true,
  });
  const q = s.state().decisions.find((d) => d.trigger === "review_limit");
  if (!q) throw new Error("Missing review-limit decision");
  return q;
}

test.each(["pause", "release"] as const)(
  "Needs You can resolve a delegated limit after the last PM Ops leaves via %s",
  async (operation) => {
    const q = await reviewLimit(true);
    const ops = s
      .state()
      .assignments.find(
        (a) => a.scope === "standing" && a.standing_mode === "ops",
      );
    if (!ops) throw new Error("Missing PM Ops");
    if (operation === "pause")
      s.command((state, actor, ports) =>
        pauseStandingAssignment(state, actor, { assignment_id: ops.id }, ports),
      );
    else
      s.command((state, actor, ports) =>
        releaseAssignment(state, actor, { assignment_id: ops.id }, ports),
      );
    const state = s.state();
    const event = state.events.findLast(
      (e) => e.type === "decision_requested" && e.payload.decision_id === q.id,
    );
    if (!event) throw new Error("Missing handoff event");
    expect(
      routeEvent({ event, snapshot: state }).notifications.map(
        (n) => n.recipient.kind,
      ),
    ).toEqual(["needs_you", "pm_office"]);
    const response = await fetch(web.url + path("/needs-you"), {
      headers: { cookie },
    });
    expect(await response.json()).toMatchObject({
      decisions: [
        expect.objectContaining({ id: q.id, decider: "human", status: "open" }),
      ],
    });
    expect(
      (
        await request(resolvePath(q), {
          option: "raise_limit",
          raw_quote: "确认继续",
        })
      ).status,
    ).toBe(200);
    expect(
      s
        .state()
        .work_items.find((w) => w.id === s.primary.verifier.work_item_id),
    ).toMatchObject({ status: "ready", max_review_rounds: 2 });
    expect(
      s
        .state()
        .runs.filter(
          (r) =>
            r.assignment_id === s.primary.verifier.id && r.status === "queued",
        ),
    ).toHaveLength(1);
  },
);

test.each([false, true])(
  "PM Ops handles review limits through MCP and routes only human escalations to Needs You (escalate=%s)",
  async (escalate) => {
    const q = await reviewLimit(true);
    expect(q.decider).toBe("role:pm");
    const ops = s
      .state()
      .assignments.find(
        (a) => a.scope === "standing" && a.standing_mode === "ops",
      );
    if (!ops) throw new Error("Missing PM Ops");
    const recipients = () => {
      const state = s.state();
      const event = state.events.findLast(
        (e) =>
          e.type === "decision_requested" && e.payload.decision_id === q.id,
      );
      if (!event) throw new Error("Missing decision event");
      return routeEvent({ event, snapshot: state }).notifications.map(
        (n) => n.recipient.kind,
      );
    };
    const needsYou = async () =>
      (await (
        await fetch(web.url + path("/needs-you"), { headers: { cookie } })
      ).json()) as { decisions: { id: string }[] };
    expect(recipients()).toEqual(["pm_ops"]);
    expect((await needsYou()).decisions.some((d) => d.id === q.id)).toBe(false);
    const before = snapshot();
    expect(
      (await request(resolvePath(q), { option: "raise_limit" })).status,
    ).toBe(403);
    expect(snapshot()).toBe(before);
    await s.start(ops);
    const args = {
      work_item_id: s.primary.verifier.work_item_id,
      review_limit_decision: {
        decision_id: q.id,
        option: "pause",
        rationale: "先核对上一轮结论",
      },
    };
    await s.call(ops, "update_work_item", args);
    expect(s.state().decisions.find((d) => d.id === q.id)).toMatchObject({
      status: "provisional",
    });
    await s.call(ops, "update_work_item", {
      ...args,
      review_limit_decision: {
        decision_id: q.id,
        option: escalate ? "escalate" : "raise_limit",
        rationale: escalate
          ? "需求有疑问，请确认预期结果"
          : "审核无必须修复问题，继续确认交付",
      },
    });
    if (escalate) {
      expect(recipients()).toEqual(["needs_you", "pm_office"]);
      expect((await needsYou()).decisions).toContainEqual(
        expect.objectContaining({ id: q.id }),
      );
      expect(
        (
          await request(resolvePath(q), {
            option: "raise_limit",
            raw_quote: "确认继续",
          })
        ).status,
      ).toBe(200);
    } else {
      expect((await needsYou()).decisions.some((d) => d.id === q.id)).toBe(
        false,
      );
      const duplicate = await s.raw(ops, "update_work_item", {
        ...args,
        review_limit_decision: {
          ...args.review_limit_decision,
          option: "raise_limit",
        },
      });
      expect(duplicate.isError).toBe(true);
    }
    expect(
      s
        .state()
        .work_items.find((w) => w.id === s.primary.verifier.work_item_id),
    ).toMatchObject({ status: "ready", max_review_rounds: 2 });
    expect(
      s
        .state()
        .runs.filter(
          (r) =>
            r.assignment_id === s.primary.verifier.id && r.status === "queued",
        ),
    ).toHaveLength(1);
  },
);

test.each([false, true])(
  "Needs You raises the limit and resumes atomically (previously paused=%s), exactly once",
  async (paused) => {
    const q = await reviewLimit();
    if (paused) {
      expect(await request(resolvePath(q), { option: "pause" })).toMatchObject({
        status: 200,
        body: { status: "provisional" },
      });
      expect(
        s
          .state()
          .work_items.find((w) => w.id === s.primary.verifier.work_item_id),
      ).toMatchObject({ status: "waiting_decision", max_review_rounds: 1 });
    }
    const payload = { option: "raise_limit", raw_quote: "增加一轮" };
    const headers = { "Idempotency-Key": "raise-once" };
    const resolved = await request(resolvePath(q), payload, headers);
    expect(resolved).toMatchObject({
      status: 200,
      body: { status: "resolved" },
    });
    const state = s.state();
    expect(
      state.work_items.find((w) => w.id === s.primary.verifier.work_item_id),
    ).toMatchObject({ status: "ready", max_review_rounds: 2 });
    const update = state.events.find(
      (e) =>
        e.type === "work_item_updated" && e.payload.max_review_rounds === 2,
    );
    expect(update).toMatchObject({
      actor: { kind: "human" },
      payload: { resume_work_items: [] },
    });
    expect(
      state.runs.find((r) => r.review_limit_changes?.length),
    ).toMatchObject({
      review_limit_changes: [
        { event_id: update?.id, max_review_rounds: 2, actor: "human" },
      ],
    });
    expect(
      state.runs.filter(
        (r) =>
          r.assignment_id === s.primary.verifier.id && r.status === "queued",
      ),
    ).toHaveLength(1);
    const before = snapshot();
    expect(await request(resolvePath(q), payload, headers)).toEqual(resolved);
    expect(snapshot()).toBe(before);
    // A second request without the original key fails and rolls back its attempted increment.
    expect((await request(resolvePath(q), payload)).status).toBe(409);
    expect(snapshot()).toBe(before);
  },
);

test.each(["alive", "exited"] as const)(
  "raise_limit dispatches the same queued recovery Run on an %s session after its trigger was ACKed",
  async (process) => {
    const q = await reviewLimit();
    const reviewer = s.primary.verifier;
    expect(
      (await request(resolvePath(q), { option: "raise_limit" })).status,
    ).toBe(200);
    const queued = s
      .state()
      .runs.find(
        (r) => r.assignment_id === reviewer.id && r.status === "queued",
      );
    if (!queued) throw new Error("Missing queued recovery Run");
    expect(queued.kind).toBe("decision_resumed");
    // An idle Agent can read/ACK the decision before the Dispatcher gets to
    // it. Subsequent pending instructions must still start the queued work.
    await s.call(reviewer, "ack_events", {
      card_id: s.card.id,
      up_to_seq: s
        .store()
        .getUpdates({ project_id: s.project.project_id, card_id: s.card.id })
        .latest_seq,
    });
    expect(
      (
        await request(cardPath("comments"), {
          work_item_id: reviewer.work_item_id,
          body: "继续审核",
        })
      ).status,
    ).toBe(200);
    const count = s.state().runs.length;
    const startRun = vi.fn(
      async (input: Parameters<typeof startQueuedRun>[1]) =>
        startQueuedRun(
          {
            store: s.store(),
            runtime: s.runtime,
            launch: {
              config: parseLaunchConfig({
                profiles: {
                  fixture: { harness: "pi", model: "fixture-model" },
                },
              }),
              secrets: {},
            },
            dataDir: s.dataDir,
            mcpUrl: s.url(),
          },
          input,
        ),
    );
    const dispatcher = new Dispatcher({
      store: s.store(),
      runtime: {
        ...s.runtime,
        status: async () => ({
          ok: true,
          value: { process, agent: "idle", observed_seq: 2 },
        }),
      },
      snapshot: async () => ({
        model: "fixture-model",
        agent_cli_version: "fixture-1",
      }),
      startRun,
    });
    await dispatcher.tick();
    expect(s.state().runs.find((r) => r.id === queued.id)?.status).toBe(
      "dispatched",
    );
    await s.call(reviewer, "whoami");
    await dispatcher.tick();
    expect(s.state().runs).toHaveLength(count);
    expect(s.state().runs.find((r) => r.id === queued.id)).toMatchObject({
      status: "running",
      kind: "decision_resumed",
      trigger_event_id: queued.trigger_event_id,
    });
    expect(
      s.store().listNotifications({
        project_id: s.project.project_id,
        assignment_id: reviewer.id,
      }),
    ).toContainEqual(
      expect.objectContaining({
        run_id: queued.id,
        status: "belled",
        attempts: 1,
      }),
    );
    expect(startRun).toHaveBeenCalledTimes(process === "exited" ? 1 : 0);
    if (process === "alive")
      expect(s.bells.at(-1)?.text).toContain(`run=${queued.id}`);
  },
);

test.each(["decision", "provisional", "human_action", "reported"] as const)(
  "raising a review limit preserves another %s blocker",
  async (blocker) => {
    const q = await reviewLimit();
    const itemId = s.primary.verifier.work_item_id as NonNullable<
      typeof s.primary.verifier.work_item_id
    >;
    if (blocker === "human_action") {
      s.command((state, actor, ports) =>
        requestHumanAction(
          state,
          actor,
          {
            card_id: s.card.id,
            instructions: "Connect device",
            why_human: "Physical access",
            expected_return: "Connected",
            blocked_work_items: [itemId],
          },
          ports,
        ),
      );
    } else if (blocker === "reported") {
      s.store().uow.run((tx) => {
        const item = tx.work_items.get(s.project.project_id, itemId);
        if (!item) throw new Error("Missing verifier");
        tx.work_items.put(s.project.project_id, {
          ...item,
          reported_blocker: {
            reason: "Need input",
            needs: "role",
            reported_by: "human",
            reported_at: new Date().toISOString(),
          },
        });
      });
    } else {
      const other = s.command((state, actor, ports) =>
        requestDecision(
          state,
          actor,
          {
            ...question,
            card_id: s.card.id,
            blocking: true,
            affected_work_items: [itemId],
          },
          ports,
        ),
      );
      if (blocker === "provisional")
        s.store().uow.run((tx) =>
          tx.decisions.put(s.project.project_id, {
            ...other,
            status: "provisional",
          }),
        );
    }
    expect(
      (await request(resolvePath(q), { option: "raise_limit" })).status,
    ).toBe(200);
    expect(s.state().work_items.find((w) => w.id === itemId)).toMatchObject({
      status: "waiting_decision",
      max_review_rounds: 2,
    });
    expect(
      s
        .state()
        .runs.filter(
          (r) =>
            r.assignment_id === s.primary.verifier.id && r.status === "queued",
        ),
    ).toHaveLength(0);
  },
);

test("a normal decision named raise_limit does not change review budgets", async () => {
  const q = s.command((state, actor, ports) =>
    requestDecision(
      state,
      actor,
      {
        ...question,
        card_id: s.card.id,
        options: [
          {
            key: "raise_limit",
            description: "Ordinary choice",
            impact: "No budget change",
          },
        ],
        recommended: "raise_limit",
      },
      ports,
    ),
  );
  const items = s.state().work_items;
  expect(
    (await request(resolvePath(q), { option: "raise_limit" })).status,
  ).toBe(200);
  expect(s.state().work_items).toEqual(items);
});

test("a failed review-limit resolution transaction rolls back its budget, audit and resumed Run", async () => {
  const q = await reviewLimit();
  const before = snapshot();
  const headers = { "Idempotency-Key": "raise-rollback" };
  const payload = { option: "raise_limit", raw_quote: "增加一轮" };
  s.store().database.exec(
    "CREATE TRIGGER reject_limit_resolution BEFORE INSERT ON timeline WHEN json_extract(NEW.doc, '$.type') = 'decision_resolved' BEGIN SELECT RAISE(ABORT, 'resolution failure'); END",
  );
  expect(await request(resolvePath(q), payload, headers)).toMatchObject({
    status: 500,
  });
  expect(snapshot()).toBe(before);
  s.store().database.exec("DROP TRIGGER reject_limit_resolution");
  expect(await request(resolvePath(q), payload, headers)).toMatchObject({
    status: 200,
  });
  expect(
    s.state().work_items.find((w) => w.id === s.primary.verifier.work_item_id),
  ).toMatchObject({ max_review_rounds: 2, status: "ready" });
  expect(
    s
      .state()
      .runs.filter(
        (r) =>
          r.assignment_id === s.primary.verifier.id && r.status === "queued",
      ),
  ).toHaveLength(1);
});
