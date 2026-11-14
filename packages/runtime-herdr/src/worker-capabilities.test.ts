import { describe, expect, test } from "vitest";
import { fixture } from "../../../test-support/worker-capabilities.js";
import {
  checkWorkerCapabilities,
  redactWorkerManifest,
} from "./worker-capabilities.js";

describe("worker capability evidence", () => {
  test("requires separate installation, configuration and account/combination evidence", () => {
    const { manifest, requirements } = fixture();
    expect(checkWorkerCapabilities(manifest, requirements)).toEqual([]);
    for (const mutation of [
      { installed: null },
      { configured: false },
      { last_verified: null },
      { version: "25.0.0" },
      { arch: "x64" },
      { path: null },
      {
        last_verified: {
          at: manifest.sampled_at,
          uid: 502,
          combination: requirements.combination,
          evidence: "other-account",
        },
      },
    ]) {
      const altered = structuredClone(manifest);
      Object.assign(altered.capabilities.node ?? {}, mutation);
      expect(
        checkWorkerCapabilities(altered, requirements).length,
      ).toBeGreaterThan(0);
    }
  });
  test("requires declared x64 runtime/Rosetta and desktop evidence only when requested", () => {
    const { manifest, requirements } = fixture();
    requirements.tools.runtime = { version: "1.0.0", arch: "x64" };
    requirements.desktop = true;
    const failures = checkWorkerCapabilities(manifest, requirements);
    expect(failures).toEqual(
      expect.arrayContaining([
        "capability:runtime",
        "capability:rosetta",
        "capability:keychain",
        "capability:screen-capture",
      ]),
    );
  });
  test("public evidence omits raw paths and arbitrary diagnostics", () => {
    const { manifest } = fixture();
    Object.assign(manifest, { diagnostic: "sensitive diagnostic" });
    const output = JSON.stringify(redactWorkerManifest(manifest));
    expect(output).not.toContain("/private/account");
    expect(output).not.toContain("sensitive diagnostic");
    expect(output).toContain("tool-path:");
  });
});
