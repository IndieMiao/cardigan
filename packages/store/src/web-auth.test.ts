/**
 * M5.1 web credentials and sessions (plan phase-1-m5 §0, §3.2; development
 * plan §14).
 *
 * The properties under test are the ones a compromise would need: the database
 * holds no usable secret, a password change invalidates every session, and
 * logout/expiry are decided from stored rows rather than from the cookie.
 */

import { expect, test } from "vitest";
import { Store } from "../src/store.js";
import {
  DEFAULT_WEB_SESSION_TTL_MS,
  hashWebPassword,
  hashWebSessionToken,
  MIN_WEB_PASSWORD_LENGTH,
  verifyWebPassword,
} from "../src/web-auth.js";

const PASSWORD = "correct horse battery";

function memoryStore(clock = { now: () => "2026-01-01T00:00:00.000Z" }) {
  return Store.open({ dbPath: ":memory:", clock });
}

test("the stored hash carries its own salt and parameters", () => {
  const first = hashWebPassword(PASSWORD);
  const second = hashWebPassword(PASSWORD);
  expect(first).not.toBe(second);
  expect(first.startsWith("scrypt$")).toBe(true);
  expect(first).not.toContain(PASSWORD);
  expect(verifyWebPassword(PASSWORD, first)).toBe(true);
  expect(verifyWebPassword(PASSWORD, second)).toBe(true);
  expect(verifyWebPassword("correct horse batterY", first)).toBe(false);
  expect(verifyWebPassword(PASSWORD, "scrypt$broken")).toBe(false);
  expect(verifyWebPassword(PASSWORD, "")).toBe(false);
});

test("a password shorter than the minimum is refused", () => {
  const store = memoryStore();
  try {
    expect(() => store.setWebPassword("short")).toThrow(
      new RegExp(String(MIN_WEB_PASSWORD_LENGTH)),
    );
    expect(store.webPasswordConfigured()).toBe(false);
    store.setWebPassword("a".repeat(MIN_WEB_PASSWORD_LENGTH));
    expect(store.webPasswordConfigured()).toBe(true);
  } finally {
    store.close();
  }
});

test("an unset password never verifies", () => {
  const store = memoryStore();
  try {
    expect(store.verifyWebLogin(PASSWORD)).toBe(false);
  } finally {
    store.close();
  }
});

test("a session resolves until it is revoked", () => {
  const store = memoryStore();
  try {
    store.setWebPassword(PASSWORD);
    const issued = store.createWebSession();
    expect(store.webSession(issued.token)?.expires_at).toBe(
      new Date(
        Date.parse("2026-01-01T00:00:00.000Z") + DEFAULT_WEB_SESSION_TTL_MS,
      ).toISOString(),
    );
    expect(store.revokeWebSession(issued.token)).toBe(true);
    expect(store.webSession(issued.token)).toBeUndefined();
    // Logging out twice is not an error, it just changes nothing.
    expect(store.revokeWebSession(issued.token)).toBe(false);
  } finally {
    store.close();
  }
});

test("changing the password invalidates every session", () => {
  const store = memoryStore();
  try {
    store.setWebPassword(PASSWORD);
    const first = store.createWebSession();
    const second = store.createWebSession();
    expect(store.countWebSessions()).toBe(2);

    store.setWebPassword("another long passphrase");
    expect(store.countWebSessions()).toBe(0);
    expect(store.webSession(first.token)).toBeUndefined();
    expect(store.webSession(second.token)).toBeUndefined();
    expect(store.verifyWebLogin(PASSWORD)).toBe(false);
    expect(store.verifyWebLogin("another long passphrase")).toBe(true);
  } finally {
    store.close();
  }
});

test("an expired session answers undefined without being revoked", () => {
  let now = "2026-01-01T00:00:00.000Z";
  const store = memoryStore({ now: () => now });
  try {
    store.setWebPassword(PASSWORD);
    const issued = store.createWebSession({ ttlMs: 1_000 });
    now = "2026-01-01T00:00:00.500Z";
    expect(store.webSession(issued.token)).toBeDefined();
    now = "2026-01-01T00:00:02.000Z";
    expect(store.webSession(issued.token)).toBeUndefined();
  } finally {
    store.close();
  }
});

test("the database stores only the sha256 of a session token", () => {
  const store = memoryStore();
  try {
    store.setWebPassword(PASSWORD);
    const issued = store.createWebSession();
    const rows = store.database
      .prepare("SELECT id_hash FROM web_sessions")
      .all() as { id_hash: string }[];
    expect(rows.map((row) => row.id_hash)).toEqual([
      hashWebSessionToken(issued.token),
    ]);
    expect(JSON.stringify(rows)).not.toContain(issued.token);
  } finally {
    store.close();
  }
});
