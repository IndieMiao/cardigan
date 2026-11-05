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
  type Decision,
  requestDecision,
  requestHumanAction,
  requestWorktreeCleanup,
} from "@cardigan/domain";
import { afterEach, beforeEach, expect, test } from "vitest";
import { type M4Cross, m4Cross } from "../../test-support/m4-cross.js";
import { resolveWebConfig } from "./config.js";
import { HttpRejection } from "./http.js";
import { type RunningWebServer, startWebServer } from "./server.js";
import { serveWrite } from "./write.js";

let s: M4Cross, web: RunningWebServer, cookie: string;
const password = "workbench test password";
const question = {
  category: "general" as const,
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
  expect(
    await request(resolvePath(q), { option: "go", raw_quote: "  选 go  " }),
  ).toMatchObject({
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
      { ...question, decider: "role:reviewer" },
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
  expect(
    await request(url, { text: "Connected", attachments: [] }),
  ).toMatchObject({
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
  const uploaded = await request(cardPath("attachments"), p);
  expect(uploaded).toMatchObject({
    status: 200,
    body: { sha256: digest, uploaded_by: "human" },
  });
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
      "/decisions/q(1)/resolve",
      "/decisions/q(1)/comments",
      "/human-actions/h(1)/complete",
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
