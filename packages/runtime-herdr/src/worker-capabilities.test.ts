import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { fixture } from "../../../test-support/worker-capabilities.js";
import {
  checkWorkerCapabilities,
  redactWorkerManifest,
  sampleWorkerCapabilities,
  workerCombination,
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
  test("unchanged target declarations cannot reuse evidence after versions or paths change", () => {
    const { manifest, requirements } = fixture();
    const original = workerCombination(manifest, requirements.combination);
    const node = manifest.capabilities.node;
    if (!node) throw new Error("Missing fixture");
    node.version = "24.2.0";
    expect(workerCombination(manifest, requirements.combination)).not.toBe(
      original,
    );
    expect(checkWorkerCapabilities(manifest, requirements)).toContain(
      "capability:node",
    );
    node.version = "24.1.0";
    node.resolved_path = "/different/node";
    expect(checkWorkerCapabilities(manifest, requirements)).toContain(
      "capability:node",
    );
  });
  test("live tool sampling reports exact Node/Python identity without manufacturing verification", () => {
    const python = execFileSync("sh", ["-c", "command -v python3"], {
      encoding: "utf8",
    }).trim();
    const sample = sampleWorkerCapabilities({
      python,
      helper: fileURLToPath(
        new URL("../../../deploy/worker-primitives.py", import.meta.url),
      ),
      timeout_ms: 3000,
      path: [
        dirname(process.execPath),
        dirname(python),
        "/opt/homebrew/bin",
        "/usr/bin",
        "/bin",
      ].join(":"),
      tools: {
        node: {
          path: process.execPath,
          resolved_path: realpathSync(process.execPath),
        },
        python: { path: python, resolved_path: realpathSync(python) },
      },
    });
    expect(sample.uid).toBe(process.getuid?.());
    expect(sample.capabilities.node).toMatchObject({
      installed: true,
      configured: true,
      version: process.versions.node,
      arch: process.arch,
      last_verified: null,
    });
    expect(sample.capabilities.python?.version).toMatch(/^3\.\d+\.\d+$/);
    expect(
      Object.values(sample.capabilities).every(
        (capability) => capability.last_verified === null,
      ),
    ).toBe(true);
  });
});
