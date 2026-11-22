import { parseLaunchConfig, resolveProfile } from "@cardigan/roles";
import { expect, test, vi } from "vitest";
import {
  findProviderModel,
  listProviderModels,
  MAX_LISTED_MODELS,
} from "./launch-model-probe.js";

// C-564: the Provider's own model listing, against a mocked endpoint only.
const key = "fixture-listing-credential-9z";
const target = (api: string, extra: Record<string, unknown> = {}) =>
  resolveProfile(
    parseLaunchConfig({
      providers: {
        p: {
          api,
          base_url: "https://relay.example.invalid",
          secret_env: {
            [api === "anthropic-messages" ? "ANTHROPIC_API_KEY" : "API_KEY"]:
              "K",
          },
          ...extra,
        },
      },
      profiles: {
        p: {
          harness: api === "anthropic-messages" ? "claude-code" : "pi",
          provider: "p",
          model: "m",
        },
      },
    }),
    "p",
  );

test("pages through the listing with the Provider's own credential and keeps only plain IDs", async () => {
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(
      Response.json({
        data: [{ id: "a" }, { id: "bad\nid" }, { id: 7 }, null, { id: "a" }],
        has_more: true,
        last_id: "a",
      }),
    )
    .mockResolvedValueOnce(Response.json({ data: [{ id: "b" }] }));
  expect(
    await listProviderModels(
      target("anthropic-messages"),
      { K: key },
      undefined,
      { fetch },
    ),
  ).toEqual({ ids: ["a", "b"], complete: true });
  expect(fetch.mock.calls.map(([url]) => url)).toEqual([
    "https://relay.example.invalid/v1/models",
    "https://relay.example.invalid/v1/models?after_id=a",
  ]);
  expect(fetch.mock.calls[0][1]).toMatchObject({
    method: "GET",
    redirect: "error",
    headers: { "x-api-key": key },
  });
});

test("limits make a partial listing; a failure says nothing of the response or the credential", async () => {
  const more = vi.fn(async () =>
    Response.json({ data: [{ id: "x" }], has_more: true, last_id: "x" }),
  );
  expect(
    await listProviderModels(
      target("openai-completions"),
      { K: key },
      { max_pages: 1 },
      { fetch: more },
    ),
  ).toEqual({ ids: ["x"], complete: false });
  expect(
    await listProviderModels(
      target("openai-completions"),
      { K: key },
      { max_bytes: 3 },
      { fetch: more },
    ),
  ).toEqual({ ids: [], complete: false });
  const denied = vi.fn(async () => new Response(`no ${key}`, { status: 401 }));
  const error = await listProviderModels(
    target("anthropic-messages"),
    { K: key },
    undefined,
    { fetch: denied },
  ).catch((e: Error) => e);
  expect(error).toBeInstanceOf(Error);
  expect(String((error as Error).message)).not.toContain(key);
  expect(String((error as Error).message)).not.toContain("401");
  // No credential value: refused before any request.
  await expect(
    listProviderModels(target("anthropic-messages"), {}, undefined, {
      fetch: denied,
    }),
  ).rejects.toThrow();
  expect(denied).toHaveBeenCalledOnce();
});

test("C-564: keeping at most the cap of IDs reports the listing as partial", async () => {
  const many = vi.fn(async () =>
    Response.json({
      data: Array.from({ length: MAX_LISTED_MODELS + 1 }, (_, i) => ({
        id: `m-${i}`,
      })),
    }),
  );
  const listed = await listProviderModels(
    target("anthropic-messages"),
    { K: key },
    { max_bytes: 10 * 1024 * 1024 },
    { fetch: many },
  );
  expect(listed.ids).toHaveLength(MAX_LISTED_MODELS);
  expect(listed.complete).toBe(false);
});

test("C-564: a typed ID is looked up page by page and never sent; an abort stops further pages", async () => {
  const pages = vi
    .fn()
    .mockResolvedValueOnce(
      Response.json({ data: [{ id: "a" }], has_more: true, last_id: "a" }),
    )
    .mockResolvedValueOnce(Response.json({ data: [{ id: "wanted" }] }));
  expect(
    await findProviderModel(
      target("anthropic-messages"),
      { K: key },
      undefined,
      "wanted",
      { fetch: pages },
    ),
  ).toBe("listed");
  for (const [url, init] of pages.mock.calls) {
    expect(String(url)).not.toContain("wanted");
    expect(init.body).toBeUndefined();
  }
  const once = vi.fn(async () => Response.json({ data: [{ id: "a" }] }));
  expect(
    await findProviderModel(
      target("anthropic-messages"),
      { K: key },
      undefined,
      "missing",
      { fetch: once },
    ),
  ).toBe("not_listed");
  const controller = new AbortController();
  controller.abort();
  const never = vi.fn(async () => Response.json({ data: [] }));
  await expect(
    findProviderModel(
      target("anthropic-messages"),
      { K: key },
      undefined,
      "x",
      {
        fetch: never,
        signal: controller.signal,
      },
    ),
  ).rejects.toThrow();
  expect(never).not.toHaveBeenCalled();
});
