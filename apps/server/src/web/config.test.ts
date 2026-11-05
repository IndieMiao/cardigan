/**
 * M5.1 Workbench configuration (plan phase-1-m5 §0, §3.1).
 *
 * `CARDIGAN_WEB_PORT` may change the port and nothing else; any attempt to move
 * the listener off the loopback interface must refuse to start instead of
 * warning, because a listener that came up on a LAN address has already
 * exposed the Workbench.
 */
import { expect, test } from "vitest";
import {
  allowedHosts,
  DEFAULT_WEB_PORT,
  resolveWebConfig,
  WEB_LOCAL_ONLY_MESSAGE,
} from "./config.js";

test("the default listener is 127.0.0.1:7781 with the 7-day session", () => {
  const config = resolveWebConfig();
  expect(config.host).toBe("127.0.0.1");
  expect(config.port).toBe(DEFAULT_WEB_PORT);
  expect(config.port).toBe(7781);
  expect(config.sessionTtlMs).toBe(7 * 24 * 60 * 60 * 1000);
  expect(config.staticDir.endsWith("apps/web/dist/")).toBe(true);
});

test("CARDIGAN_WEB_PORT changes the port", () => {
  expect(resolveWebConfig({ CARDIGAN_WEB_PORT: "8080" }).port).toBe(8080);
  expect(resolveWebConfig({ CARDIGAN_WEB_PORT: "0" }).port).toBe(0);
  for (const value of ["http", "-1", "70000", "7781.5"]) {
    expect(() => resolveWebConfig({ CARDIGAN_WEB_PORT: value })).toThrow(
      /CARDIGAN_WEB_PORT/,
    );
  }
});

test("loopback spellings are accepted and anything else refuses to start", () => {
  for (const host of ["127.0.0.1", "::1", "localhost"]) {
    expect(resolveWebConfig({}, { host }).host).toBe(host);
  }
  for (const host of ["0.0.0.0", "192.168.1.10", "::", "cardigan.example"]) {
    expect(() => resolveWebConfig({}, { host })).toThrow(
      WEB_LOCAL_ONLY_MESSAGE,
    );
  }
});

test("the Host allow-list names this listener with its port", () => {
  expect(allowedHosts("127.0.0.1", 7781).sort()).toEqual([
    "127.0.0.1:7781",
    "localhost:7781",
  ]);
  expect(allowedHosts("::1", 7781)).toContain("[::1]:7781");
});
