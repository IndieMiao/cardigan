import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseLaunchConfig } from "@cardigan/roles";
import { Store } from "@cardigan/store";
import { expect, test } from "vitest";
import { launchFingerprint } from "./launch-fingerprint.js";

test("same profile and model: only effective settings and referenced credentials affect its opaque identity", () => {
  const store = Store.open({ dbPath: ":memory:" });
  const compute = (
    effort: string,
    url: string,
    secret: string,
    unrelated: string,
    otherModel: string,
  ) =>
    launchFingerprint(
      store,
      {
        config: parseLaunchConfig({
          providers: {
            relay: {
              harness: "pi",
              api: "openai-responses",
              base_url: url,
              secret_env: { TOKEN: "USED" },
            },
          },
          profiles: {
            p: { harness: "pi", model: "stable", effort, provider: "relay" },
            other: { harness: "codex", model: otherModel },
          },
        }),
        secrets: { USED: secret, UNUSED: unrelated },
      },
      "p",
    );
  try {
    const u = "https://first.example.invalid/v1",
      s = "fixture-only";
    const original = compute("low", u, s, "other", "a");
    expect(original).toMatch(/^[0-9a-f]{64}$/u);
    expect(compute("low", u, s, "rotated", "b")).toBe(original);
    expect(compute("high", u, s, "other", "a")).not.toBe(original);
    expect(compute("low", u, "replacement", "other", "a")).not.toBe(original);
    expect(
      compute("low", "https://second.example.invalid/v1", s, "other", "a"),
    ).not.toBe(original);
  } finally {
    store.close();
  }
});

test("unused databases contain no comparison key; used databases keep their own key across reopen", () => {
  const root = mkdtempSync(join(tmpdir(), "cg-fingerprint-"));
  const config = parseLaunchConfig({
    profiles: { p: { harness: "codex", model: "m" } },
  });
  const fingerprint = (store: Store) =>
    launchFingerprint(store, { config, secrets: {} }, "p");
  const count = (store: Store) =>
    store.database
      .prepare("SELECT COUNT(*) AS n FROM launch_comparison_key")
      .get()?.n;
  try {
    const dbPath = join(root, "first.db");
    const first = Store.open({ dbPath });
    let original: string;
    try {
      expect(count(first)).toBe(0);
      original = fingerprint(first);
      expect(count(first)).toBe(1);
    } finally {
      first.close();
    }
    const reopened = Store.open({ dbPath });
    try {
      expect(fingerprint(reopened)).toBe(original);
    } finally {
      reopened.close();
    }
    const other = Store.open({ dbPath: join(root, "second.db") });
    try {
      expect(fingerprint(other)).not.toBe(original);
    } finally {
      other.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
