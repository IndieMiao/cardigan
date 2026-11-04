import { describe, expect, test } from "vitest";
import { resolveLaunchPaths } from "./paths.js";

describe("resolveLaunchPaths", () => {
  test("uses CARDIGAN_CONFIG_DIR when set", () => {
    const paths = resolveLaunchPaths(
      { CARDIGAN_CONFIG_DIR: "/tmp/fictional-config" },
      "/tmp/fictional-home",
    );
    expect(paths.configDir).toBe("/tmp/fictional-config");
    expect(paths.launchFile).toBe("/tmp/fictional-config/launch.yaml");
    expect(paths.secretsFile).toBe("/tmp/fictional-config/secrets.env");
  });

  test("falls back to ~/.config/cardigan", () => {
    const paths = resolveLaunchPaths({}, "/tmp/fictional-home");
    expect(paths.configDir).toBe("/tmp/fictional-home/.config/cardigan");
  });

  test("ignores an empty CARDIGAN_CONFIG_DIR", () => {
    const paths = resolveLaunchPaths(
      { CARDIGAN_CONFIG_DIR: "" },
      "/tmp/fictional-home",
    );
    expect(paths.configDir).toBe("/tmp/fictional-home/.config/cardigan");
  });

  test("prefers $XDG_RUNTIME_DIR/cardigan for generated files", () => {
    const paths = resolveLaunchPaths(
      { XDG_RUNTIME_DIR: "/run/user/4242" },
      "/tmp/fictional-home",
    );
    expect(paths.runtimeDir).toBe("/run/user/4242/cardigan");
  });

  test("falls back to ~/.cache/cardigan/run", () => {
    const paths = resolveLaunchPaths({}, "/tmp/fictional-home");
    expect(paths.runtimeDir).toBe("/tmp/fictional-home/.cache/cardigan/run");
  });
});
