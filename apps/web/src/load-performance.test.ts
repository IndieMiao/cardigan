// @vitest-environment node
import { afterEach, beforeEach, expect, test, vi } from "vitest";

const browser = vi.hoisted(() => ({
  send: vi.fn(async () => ({})),
  close: vi.fn(async () => {}),
  evaluate: vi.fn(async () => ({
    ready: 10,
    focused: true,
    fontsReady: 12,
    sse: [{ duration: 2 }],
    resources: [],
  })),
  errors: [],
}));
vi.mock("../test-support/chromium.mjs", () => ({
  chromium: async () => browser,
}));

const originalArgv = process.argv;
const password = "fixture-password-not-for-output";
const cookie = "cardigan_session=fixture-cookie-not-for-output";

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  process.argv = [
    "node",
    "load-performance.mjs",
    "--url",
    "https://workbench.example",
    "--project",
    "fixture",
    "--samples",
    "1",
  ];
  vi.stubEnv("WORKBENCH_PASSWORD", password);
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "table").mockImplementation(() => {});
});
afterEach(() => {
  process.argv = originalArgv;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

function mockRequests(logout: () => Promise<Response>) {
  const request = vi.fn(async (url: string) => {
    if (url.endsWith("/api/login"))
      return new Response("{}", {
        headers: { "set-cookie": `${cookie}; HttpOnly` },
      });
    if (url.endsWith("/api/logout")) return logout();
    throw new Error("Unexpected request");
  });
  vi.stubGlobal("fetch", request);
  return request;
}

test("remote collection completes only after successful session cleanup", async () => {
  const requests = mockRequests(
    async () => new Response(null, { status: 204 }),
  );
  await import("../test-support/load-performance.mjs");
  expect(browser.evaluate).toHaveBeenCalledTimes(2);
  expect(browser.close).toHaveBeenCalledOnce();
  expect(requests).toHaveBeenLastCalledWith(
    "https://workbench.example/api/logout",
    {
      method: "POST",
      body: "{}",
      headers: {
        origin: "https://workbench.example",
        cookie,
        "content-type": "application/json",
      },
    },
  );
});

test.each([401, 500, 503])(
  "logout HTTP %i fails the collection without exposing credentials",
  async (status) => {
    mockRequests(async () => new Response(`${password} ${cookie}`, { status }));
    const error = await import("../test-support/load-performance.mjs").catch(
      (error: Error) => error,
    );
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).toContain(`session cleanup failed (HTTP ${status})`);
    expect(String(error)).toContain("session may still be active");
    expect(String(error)).not.toContain(password);
    expect(String(error)).not.toContain(cookie);
    expect(browser.close).toHaveBeenCalledOnce();
  },
);

test("logout transport errors are reported without their potentially sensitive details", async () => {
  mockRequests(async () => {
    throw new Error(`${password} ${cookie}`);
  });
  await expect(import("../test-support/load-performance.mjs")).rejects.toThrow(
    "Workbench session cleanup failed (network error); the session may still be active.",
  );
});

test("browser cleanup failure does not skip session revocation", async () => {
  const logout = vi.fn(async () => new Response(null, { status: 204 }));
  mockRequests(logout);
  browser.close.mockRejectedValueOnce(new Error("Browser cleanup failed"));
  await expect(import("../test-support/load-performance.mjs")).rejects.toThrow(
    "Browser cleanup failed",
  );
  expect(logout).toHaveBeenCalledOnce();
});
