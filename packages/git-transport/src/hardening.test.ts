import { afterEach, expect, test, vi } from "vitest";
import { gitEnvironment } from "./hardening.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

test("host Git runs untranslated so failures can be classified in any locale", () => {
  vi.stubEnv("LANG", "zh_CN.UTF-8");
  vi.stubEnv("LC_ALL", "zh_CN.UTF-8");
  vi.stubEnv("GIT_DIR", "/elsewhere");
  const env = gitEnvironment();
  expect(env).toMatchObject({ LC_ALL: "C", LANGUAGE: "C" });
  expect(env.GIT_DIR).toBeUndefined();
});
