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
