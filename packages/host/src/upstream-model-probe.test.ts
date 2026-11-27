import { parseLaunchConfig, resolveProfile } from "@cardigan/roles";
import { expect, test, vi } from "vitest";
import { probeUpstreamModel } from "./launch-model-probe.js";

// C-821: the recovery probe of a model service outage, against a mocked endpoint only.
const key = "fixture-outage-credential-7q";
const body = "No available accounts: fixture-response-body-secret";
const target = (
  api = "anthropic-messages",
  extra: Record<string, unknown> = {},
) =>
  resolveProfile(
    parseLaunchConfig({
      providers: {
        relay: {
          api,
          base_url: "https://relay.example.invalid",
          secret_env: {
            [api === "anthropic-messages" ? "ANTHROPIC_AUTH_TOKEN" : "API_KEY"]:
              "K",
          },
          ...extra,
        },
      },
      profiles: {
        high: {
          harness: api === "anthropic-messages" ? "claude-code" : "pi",
          provider: "relay",
          model: "claude-opus",
        },
      },
    }),
    "high",
  );

test("sends one minimal model request with the profile's own credential", async () => {
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(
      Response.json({ content: [{ type: "text", text: "H" }] }),
    );
  expect(
    await probeUpstreamModel(target(), { K: key }, undefined, { fetch }),
  ).toEqual({ ok: true });
  expect(fetch).toHaveBeenCalledOnce();
  const [url, init] = fetch.mock.calls[0] as [string, RequestInit];
  expect(url).toBe("https://relay.example.invalid/v1/messages");
  expect(init).toMatchObject({ method: "POST", redirect: "error" });
  expect(JSON.parse(String(init.body))).toEqual({
    model: "claude-opus",
    messages: [{ role: "user", content: "Hi" }],
    max_tokens: 1,
  });
  expect((init.headers as Record<string, string>).authorization).toBe(
    `Bearer ${key}`,
  );
});

test.each([
  [
    "503 No available accounts",
    () => new Response(body, { status: 503 }),
    { ok: false, failure: "http_status", status: 503 },
  ],
  [
    "429",
    () => new Response(body, { status: 429 }),
    { ok: false, failure: "http_status", status: 429 },
  ],
  [
    "an error object",
    () => Response.json({ content: [], error: { message: body } }),
    { ok: false, failure: "invalid_response" },
  ],
  [
    "a body that is not JSON",
    () => new Response(body, { status: 200 }),
    { ok: false, failure: "invalid_response" },
  ],
])("reports %s as a status or class only", async (_name, reply, expected) => {
  const fetch = vi.fn().mockResolvedValueOnce(reply());
  const result = await probeUpstreamModel(target(), { K: key }, undefined, {
    fetch,
  });
  expect(result).toEqual(expected);
  // Neither the credential nor any part of the response leaves the probe.
  expect(JSON.stringify(result)).not.toContain(key);
  expect(JSON.stringify(result)).not.toContain("fixture-response-body-secret");
});

test("network failures and timeouts are classified without their messages", async () => {
  const failing = vi
    .fn()
    .mockRejectedValueOnce(new TypeError(`fetch failed for ${key}`));
  expect(
    await probeUpstreamModel(target(), { K: key }, undefined, {
      fetch: failing,
    }),
  ).toEqual({ ok: false, failure: "connection_error" });
  const slow = vi
    .fn()
    .mockRejectedValueOnce(
      Object.assign(new Error(key), { name: "TimeoutError" }),
    );
  expect(
    await probeUpstreamModel(target(), { K: key }, undefined, { fetch: slow }),
  ).toEqual({ ok: false, failure: "timeout" });
});

test("without an explicit endpoint, model or credential nothing is sent", async () => {
  const fetch = vi.fn();
  expect(await probeUpstreamModel(target(), {}, undefined, { fetch })).toEqual({
    ok: false,
    failure: "not_configured",
  });
  expect(
    await probeUpstreamModel(
      target("anthropic-messages", {
        base_url: "http://relay.example.invalid",
      }),
      { K: key },
      undefined,
      { fetch },
    ),
  ).toEqual({ ok: false, failure: "not_configured" });
  expect(fetch).not.toHaveBeenCalled();
});

test("OpenAI-compatible endpoints use their own minimal request", async () => {
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(Response.json({ choices: [{ index: 0 }] }));
  expect(
    await probeUpstreamModel(
      target("openai-completions"),
      { K: key },
      undefined,
      {
        fetch,
      },
    ),
  ).toEqual({ ok: true });
  expect(fetch.mock.calls[0]?.[0]).toBe(
    "https://relay.example.invalid/v1/chat/completions",
  );
});
