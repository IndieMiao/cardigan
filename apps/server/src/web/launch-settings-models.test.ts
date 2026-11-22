import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  isAcceptedLaunchRevision,
  selectableLaunchConfig,
} from "@cardigan/host";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { call, webHarness } from "../../test-support/web.js";
import { loadLaunchFiles } from "../host.js";
import { liveLaunch } from "../live-launch.js";
import { ModelLists } from "./launch-settings-models.js";

// C-564: the profile form's model choices come from the models.dev catalog
// and from the saved Provider's own `/models` listing, made on the host with
// the Provider's own (synthetic) credential to its own (mocked) endpoint.
// No real Provider, models.dev or inference is contacted.
const gatewayKey = "fixture-gateway-credential-1a2b",
  relayKey = "fixture-relay-credential-3c4d";
const config = `providers:
  anthropic:
    api: anthropic-messages
    base_url: https://gateway.example.invalid
    secret_env: { ANTHROPIC_API_KEY: GATEWAY_KEY }
  relay:
    api: openai-completions
    harness: pi
    base_url: https://relay.example.invalid/v1
    secret_env: { RELAY_API_KEY: RELAY_KEY }
  unset:
    api: anthropic-messages
    base_url: https://unset.example.invalid
    secret_env: { ANTHROPIC_API_KEY: MISSING_KEY }
  bare:
    harness: pi
models:
  opus: { provider: anthropic, id: claude-fixture-opus }
profiles:
  claude: { harness: claude-code, provider: anthropic, model: opus, permission_mode: legacyMode }
  coder: { harness: pi, provider: relay, model: relay-chat }
`;
const catalog = {
  fetched_at: new Date().toISOString(),
  entries: [
    {
      provider: "anthropic",
      id: "claude-fixture-opus",
      context_window: 200000,
      max_output_tokens: 32000,
      reasoning_efforts: ["low", "high"],
    },
    { provider: "anthropic", id: "claude-fixture-haiku", context_window: 1000 },
    { provider: "openai", id: "relay-chat", context_window: 64000 },
    { provider: "openai", id: "gpt-fixture", context_window: 128000 },
  ],
};

let live: Awaited<
  ReturnType<typeof liveLaunch<Awaited<ReturnType<typeof loadLaunchFiles>>>>
>;
let dir: string,
  h: Awaited<ReturnType<typeof webHarness>>,
  cookie: string,
  version: string;
const post = (
  rest: string,
  body: unknown,
  headers: Record<string, string> = {},
  session = cookie,
) =>
  call(h.port, `/api/launch-settings/${rest}`, {
    method: "POST",
    cookie: session,
    headers: {
      origin: `http://${h.hostHeader}`,
      "content-type": "application/json",
      "idempotency-key": "one",
      ...headers,
    },
    body: JSON.stringify(body),
  });
const models = (provider: string, at = version) =>
  post("models", { version: at, provider });
const reread = async () => {
  const read = await call(h.port, "/api/launch-settings", { cookie });
  expect(read.status, read.body).toBe(200);
  version = JSON.parse(read.body).version;
  return JSON.parse(read.body);
};
/** A mocked network: each endpoint answers its own listing. */
const network = vi.fn(async (url: string | URL, init?: RequestInit) => {
  const href = String(url);
  const headers = (init?.headers ?? {}) as Record<string, string>;
  if (href === "https://gateway.example.invalid/v1/models")
    return headers["x-api-key"] === gatewayKey
      ? Response.json({
          data: [{ id: "claude-fixture-opus" }, { id: "gateway-only" }],
          has_more: false,
        })
      : new Response(`denied ${gatewayKey}`, { status: 401 });
  if (href === "https://relay.example.invalid/v1/models")
    return headers.authorization === `Bearer ${relayKey}`
      ? Response.json({ data: [{ id: "relay-chat" }, { id: "relay-mini" }] })
      : new Response("denied", { status: 401 });
  return new Response("not found", { status: 404 });
});

beforeEach(async () => {
  network.mockClear();
  vi.stubGlobal("fetch", network);
  dir = mkdtempSync(join(tmpdir(), "launch-models-"));
  writeFileSync(join(dir, "launch.yaml"), config, { mode: 0o600 });
  writeFileSync(
    join(dir, "secrets.env"),
    `GATEWAY_KEY=${gatewayKey}\nRELAY_KEY=${relayKey}\n`,
    { mode: 0o600 },
  );
  h = await webHarness({
    password: "launch-password",
    diskStore: true,
    launchSettings: {
      dir,
      effective: () =>
        isAcceptedLaunchRevision(h.store, dir, live.current().revision)
          ? selectableLaunchConfig(live.current())
          : { ...live.current().config, profiles: {} },
      adopt: (generation) => live.adopt(generation),
    },
  });
  writeFileSync(join(h.dataDir, "models-dev.json"), JSON.stringify(catalog));
  live = await liveLaunch(
    dir,
    () => loadLaunchFiles(dir, () => {}, h.dataDir, h.store),
    () => {},
    (next) => isAcceptedLaunchRevision(h.store, dir, next.revision),
  );
  cookie = await h.login("launch-password");
  await reread();
});
afterEach(async () => {
  await h?.close();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  rmSync(dir, { force: true, recursive: true });
});

test("a Provider's choices merge the catalog and its own listing, with metadata; the credential goes only to its endpoint", async () => {
  const response = await models("anthropic");
  expect(response.status, response.body).toBe(200);
  expect(response.json).toEqual({
    version,
    provider: "anthropic",
    catalog: {
      status: "ok",
      providers: ["anthropic"],
      fetched_at: catalog.fetched_at,
    },
    listing: { status: "ok" },
    models: [
      {
        id: "claude-fixture-haiku",
        sources: ["catalog"],
        context_window: 1000,
      },
      {
        id: "claude-fixture-opus",
        sources: ["catalog", "provider"],
        context_window: 200000,
        max_output_tokens: 32000,
        reasoning_efforts: ["low", "high"],
      },
      { id: "gateway-only", sources: ["provider"] },
    ],
  });
  // A fresh shared cache: models.dev is not downloaded. One listing request.
  expect(network.mock.calls.map(([url]) => String(url))).toEqual([
    "https://gateway.example.invalid/v1/models",
  ]);
  expect(network.mock.calls[0]?.[1]).toMatchObject({
    method: "GET",
    redirect: "error",
    headers: { "x-api-key": gatewayKey },
  });
  // Cached: a second read within the TTL makes no request.
  expect((await models("anthropic")).status).toBe(200);
  expect(network).toHaveBeenCalledOnce();
  expect(response.body).not.toContain(gatewayKey);
});

test("each Provider is listed with its own endpoint and credential; listings never mix", async () => {
  const relay = await models("relay");
  expect(relay.status, relay.body).toBe(200);
  // Not in the catalog by ID: listed by the Provider, metadata borrowed from
  // the protocol family (openai) only for IDs the Provider itself lists.
  expect(relay.json).toMatchObject({
    catalog: { status: "not_listed", providers: [] },
    listing: { status: "ok" },
    models: [
      { id: "relay-chat", sources: ["provider"], context_window: 64000 },
      { id: "relay-mini", sources: ["provider"] },
    ],
  });
  const anthropic = await models("anthropic");
  expect(JSON.stringify(anthropic.json)).not.toContain("relay-");
  expect(JSON.stringify(relay.json)).not.toContain("gateway-only");
  const calls = network.mock.calls.map(([url, init]) => [
    String(url),
    init?.headers,
  ]);
  expect(calls).toEqual([
    [
      "https://relay.example.invalid/v1/models",
      expect.objectContaining({ authorization: `Bearer ${relayKey}` }),
    ],
    [
      "https://gateway.example.invalid/v1/models",
      expect.objectContaining({ "x-api-key": gatewayKey }),
    ],
  ]);
  expect(JSON.stringify(calls[0])).not.toContain(gatewayKey);
  expect(JSON.stringify(calls[1])).not.toContain(relayKey);
});

test("a failed listing keeps the catalog choices and says why; the body, the credential and logs stay out", async () => {
  const logs = [
    vi.spyOn(console, "log"),
    vi.spyOn(console, "warn"),
    vi.spyOn(console, "error"),
  ];
  network.mockImplementationOnce(
    async () => new Response(`denied ${gatewayKey}`, { status: 401 }),
  );
  const failed = await models("anthropic");
  expect(failed.status).toBe(200);
  expect(failed.json).toMatchObject({
    catalog: { status: "ok" },
    listing: { status: "failed" },
    models: [{ id: "claude-fixture-haiku" }, { id: "claude-fixture-opus" }],
  });
  expect(failed.body).not.toContain(gatewayKey);
  expect(failed.body).not.toContain("denied");
  for (const log of logs)
    expect(JSON.stringify(log.mock.calls)).not.toContain(gatewayKey);
  const tables = h.store.database
    .prepare("SELECT name FROM sqlite_master WHERE type='table'")
    .all()
    .map((t) =>
      JSON.stringify(
        h.store.database.prepare(`SELECT * FROM "${String(t.name)}"`).all(),
      ),
    );
  expect(tables.join("\n")).not.toContain(gatewayKey);
});

test("no credential or no endpoint: nothing is requested, and the reason is given", async () => {
  expect((await models("unset")).json).toMatchObject({
    listing: { status: "missing_secret" },
  });
  expect((await models("bare")).json).toMatchObject({
    catalog: { status: "not_listed" },
    listing: { status: "no_endpoint" },
    models: [],
  });
  expect(network).not.toHaveBeenCalled();
});

test("only a saved Provider of the current snapshot, only for a human session", async () => {
  expect((await models("nope")).json).toMatchObject({
    error: { details: { field: "provider" } },
  });
  expect((await models("anthropic", "f".repeat(64))).status).toBe(409);
  expect(
    (await post("models", { version, provider: "anthropic", extra: 1 })).status,
  ).toBe(400);
  expect(
    (
      await post(
        "models",
        { version, provider: "anthropic" },
        { authorization: "Bearer agent-token" },
      )
    ).status,
  ).toBe(403);
  expect(
    (await post("models", { version, provider: "anthropic" }, {}, "")).status,
  ).toBe(401);
  expect(network).not.toHaveBeenCalled();
});

test("a listing cut short by the page limit is partial; the catalog is fetched when stale and its failure is not fatal", async () => {
  const lists = new ModelLists(h.dataDir, {
    fetch: (async (url: string | URL, init?: RequestInit) => {
      if (String(url) === "https://models.dev/api.json")
        return new Response("unavailable", { status: 503 });
      if (String(url).startsWith("https://gateway.example.invalid/v1/models"))
        return Response.json({
          data: [{ id: `m-${String(url).length}` }],
          has_more: true,
          last_id: `m-${String(url).length}`,
        });
      return network(url, init);
    }) as typeof fetch,
    // Two days later: the shared cache is too old.
    now: () => Date.now() + 2 * 24 * 60 * 60_000,
  });
  writeFileSync(
    join(dir, "launch.yaml"),
    `${config}launch_check: { max_pages: 2 }\n`,
  );
  const file = (await import("./launch-settings-file.js")).readLaunchSettings(
    dir,
    h.dataDir,
    0,
  );
  const view = await lists.list({ ...file, version: "v" }, "anthropic");
  expect(view.catalog.status).toBe("stale");
  expect(view.listing.status).toBe("partial");
  expect(
    view.models.filter((m) => m.sources.includes("provider")),
  ).toHaveLength(2);
  writeFileSync(join(h.dataDir, "models-dev.json"), "{}");
  const none = new ModelLists(h.dataDir, {
    fetch: (async () => new Response("", { status: 503 })) as typeof fetch,
  });
  const empty = await none.list({ ...file, version: "v" }, "anthropic");
  expect(empty.catalog).toEqual({
    status: "unavailable",
    providers: [],
    fetched_at: null,
  });
  expect(empty.listing.status).toBe("failed");
});

test("the read names each harness's permission modes; a new value must be one of them, an untouched old one stays", async () => {
  const read = await reread();
  expect(read.permission_modes["claude-code"]).toContain("bypassPermissions");
  expect(read.permission_modes.codex).toEqual([]);
  const preview = (fields: Record<string, unknown>, name = "claude") =>
    post("preview", {
      version,
      change: { op: "edit_profile", name, fields },
    });
  // Editing another field keeps the hand-written value.
  const other = await preview({ effort: "high" });
  expect(other.status, other.body).toBe(200);
  expect(JSON.stringify(other.json)).not.toContain("permission_mode");
  // A listed value can be chosen; an unlisted one cannot be saved anew.
  expect((await preview({ permission_mode: "acceptEdits" })).status).toBe(200);
  expect((await preview({ permission_mode: "anything" })).json).toMatchObject({
    error: { details: { field: "permission_mode" } },
  });
  expect((await preview({ permission_mode: "legacyMode" })).status).toBe(400);
  // Clearing it is allowed.
  expect((await preview({ permission_mode: null })).status).toBe(200);
  // Pi takes no permission mode at all.
  expect(
    (await preview({ permission_mode: "plan" }, "coder")).json,
  ).toMatchObject({ error: { details: { field: "permission_mode" } } });
  // Switching the harness checks the new one.
  expect(
    (await preview({ harness: "codex", permission_mode: "plan" })).status,
  ).toBe(400);
  const created = await post("preview", {
    version,
    change: {
      op: "create_profile",
      name: "fresh",
      fields: { harness: "claude-code", permission_mode: "plan" },
    },
  });
  expect(created.status, created.body).toBe(200);
});
