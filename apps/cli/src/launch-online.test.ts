import { probeModel } from "@cardigan/host";
import { parseLaunchConfig, resolveProfile } from "@cardigan/roles";
import { afterEach, expect, test, vi } from "vitest";

afterEach(() => vi.unstubAllGlobals());
const target = resolveProfile(
  parseLaunchConfig({
    providers: {
      p: {
        api: "anthropic-messages",
        base_url: "https://relay.example.invalid",
      },
    },
    profiles: {
      p: { harness: "claude-code", provider: "p", model: "desired" },
    },
  }),
  "p",
);
test("Anthropic cursor stays on the configured endpoint, and smoke runs only after a match", async () => {
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(
      Response.json({
        data: [{ id: "first/id" }],
        has_more: true,
        last_id: "first/id",
      }),
    )
    .mockResolvedValueOnce(
      Response.json({ data: [{ id: "desired" }], has_more: false }),
    )
    .mockResolvedValueOnce(Response.json({ content: [] }));
  vi.stubGlobal("fetch", fetch);
  expect(await probeModel(target, {}, true, undefined)).toBeUndefined();
  expect(fetch.mock.calls.map(([url]) => url)).toEqual([
    "https://relay.example.invalid/v1/models",
    "https://relay.example.invalid/v1/models?after_id=first%2Fid",
    "https://relay.example.invalid/v1/messages",
  ]);
});
test("bounds and repeated cursors are incomplete listings, not a missing model", async () => {
  const fetch = vi.fn(async () =>
    Response.json({ data: [{ id: "x" }], has_more: true, last_id: "x" }),
  );
  vi.stubGlobal("fetch", fetch);
  expect(await probeModel(target, {}, true, { max_pages: 1 })).toContain(
    "未查完",
  );
  expect(await probeModel(target, {}, false, {})).toContain("游标");
  expect(await probeModel(target, {}, false, { max_bytes: 3 })).toContain(
    "未查完",
  );
  expect(fetch).toHaveBeenCalledTimes(4);
});
