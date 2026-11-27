import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, expect, test } from "vitest";
import {
  CORS_UPLOAD_HEADERS,
  corsBlocked,
  corsPreflight,
  corsRuleFor,
  corsVerdictOf,
} from "./cors.js";

/**
 * C-807: a loopback bucket that answers preflights the way OSS does: no rule
 * (403 "CORS is not enabled"), a rule for other origins (403 CORSResponse),
 * or a matching rule (200 with the Access-Control-Allow-* headers).
 */
const ORIGIN = "https://gs66.example.ts.net";
const NOT_ENABLED = `<?xml version="1.0" encoding="UTF-8"?>
<Error><Code>AccessForbidden</Code><Message>CORS is not enabled for this bucket.</Message></Error>`;
const NOT_ALLOWED = `<?xml version="1.0" encoding="UTF-8"?>
<Error><Code>AccessForbidden</Code><Message>CORSResponse: This CORS request is not allowed. This is usually because the evalution of Origin, request method / Access-Control-Request-Method or Access-Control-Requet-Headers are not whitelisted by the resource's CORS spec.</Message></Error>`;

let server: Server | undefined;
afterEach(async () => {
  await new Promise((resolve) => server?.close(resolve) ?? resolve(undefined));
  server = undefined;
});

async function bucket(rule: { origins: string[] } | "none") {
  const seen: IncomingMessage[] = [];
  server = createServer((req, res) => {
    seen.push(req);
    if (rule === "none") {
      res.writeHead(403, { "content-type": "application/xml" });
      res.end(NOT_ENABLED);
      return;
    }
    const origin = String(req.headers.origin);
    if (!rule.origins.includes(origin)) {
      res.writeHead(403, { "content-type": "application/xml" });
      res.end(NOT_ALLOWED);
      return;
    }
    res.writeHead(200, {
      "access-control-allow-origin": origin,
      "access-control-allow-methods": "PUT, GET, HEAD",
      "access-control-allow-headers": String(
        req.headers["access-control-request-headers"],
      ),
      "access-control-max-age": "600",
    });
    res.end();
  });
  await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    target: {
      bucket: "cardigan-fixture",
      region: "us-west-1",
      endpoint: `http://127.0.0.1:${port}`,
    },
    seen,
  };
}

test("C-807: a matching rule passes, and the preflight carries no credential", async () => {
  const { target, seen } = await bucket({ origins: [ORIGIN] });
  expect(await corsPreflight(target, ORIGIN)).toEqual({
    origin: ORIGIN,
    verdict: "ok",
    status: 200,
  });
  const [req] = seen;
  expect(req?.method).toBe("OPTIONS");
  expect(req?.url).toMatch(/^\/shared\/[0-9a-f-]{36}$/u);
  expect(req?.headers).toMatchObject({
    origin: ORIGIN,
    "access-control-request-method": "PUT",
    "access-control-request-headers": CORS_UPLOAD_HEADERS.join(","),
  });
  // No signature, credential or signed query: the URL has no query at all.
  expect(req?.headers.authorization).toBeUndefined();
  expect(
    Object.keys(req?.headers ?? {}).filter((h) => h.startsWith("x-oss-")),
  ).toEqual([]);
  expect(req?.url).not.toContain("?");
});

test("C-807: a bucket without CORS answers 403 and is reported as not enabled", async () => {
  const { target } = await bucket("none");
  const result = await corsPreflight(target, ORIGIN);
  expect(result).toEqual({
    origin: ORIGIN,
    verdict: "not_enabled",
    status: 403,
  });
  expect(corsBlocked(result.verdict)).toBe(true);
  // The body is only classified, never returned.
  expect(JSON.stringify(result)).not.toContain("AccessForbidden");
});

test("C-807: a rule for other origins is reported as not allowed for this one", async () => {
  const { target } = await bucket({ origins: ["https://elsewhere.example"] });
  const result = await corsPreflight(target, ORIGIN);
  expect(result).toEqual({
    origin: ORIGIN,
    verdict: "not_allowed",
    status: 403,
  });
  expect(corsBlocked(result.verdict)).toBe(true);
});

test("C-807: an unreachable bucket says nothing about CORS", async () => {
  const { target } = await bucket("none");
  await new Promise((resolve) => server?.close(resolve));
  server = undefined;
  const result = await corsPreflight(target, ORIGIN);
  expect(result).toEqual({ origin: ORIGIN, verdict: "unreachable" });
  expect(corsBlocked(result.verdict)).toBe(false);
});

test("C-807: a 200 must allow the origin, PUT and both signed headers", () => {
  const ok = {
    allowOrigin: ORIGIN,
    allowMethods: "PUT",
    allowHeaders: "content-type, x-oss-forbid-overwrite",
  };
  expect(corsVerdictOf(ORIGIN, 200, ok, "")).toBe("ok");
  expect(
    corsVerdictOf(
      ORIGIN,
      200,
      { ...ok, allowOrigin: "*", allowHeaders: "*" },
      "",
    ),
  ).toBe("ok");
  expect(
    corsVerdictOf(ORIGIN, 200, { ...ok, allowOrigin: "https://other" }, ""),
  ).toBe("not_allowed");
  expect(corsVerdictOf(ORIGIN, 200, { ...ok, allowMethods: "GET" }, "")).toBe(
    "not_allowed",
  );
  expect(
    corsVerdictOf(ORIGIN, 200, { ...ok, allowHeaders: "content-type" }, ""),
  ).toBe("not_allowed");
  expect(corsVerdictOf(ORIGIN, 500, ok, "")).toBe("error");
  expect(corsVerdictOf(ORIGIN, 404, ok, "")).toBe("error");
  expect(corsRuleFor([ORIGIN])).toEqual({
    origins: [ORIGIN],
    methods: ["PUT", "GET", "HEAD"],
    headers: ["content-type", "x-oss-forbid-overwrite"],
  });
});
