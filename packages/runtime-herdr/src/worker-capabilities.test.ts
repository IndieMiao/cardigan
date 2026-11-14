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
  test("review: native Mac base tools must not accept x64 or unknown architecture without Rosetta evidence", () => {
    const results: Record<string, string[]> = {};
    for (const [id, arch] of [
      ["hc", "x64"],
      ["python", "x64"],
      ["pnpm", null],
    ] as const) {
      const { manifest, requirements } = fixture();
      const changed = manifest.capabilities[id];
      if (!changed) throw new Error("Missing fixture capability");
      changed.arch = arch;
      const combination = workerCombination(manifest, requirements.combination);
      for (const capability of Object.values(manifest.capabilities))
        if (capability.last_verified)
          capability.last_verified.combination = combination;
      results[id] = checkWorkerCapabilities(manifest, requirements);
    }
    expect(results).toEqual({
      hc: expect.any(Array),
      python: expect.any(Array),
      pnpm: expect.any(Array),
    });
    expect(
      Object.values(results).every((failures) => failures.length > 0),
      JSON.stringify(results),
    ).toBe(true);
  });
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

test.each(["hc", "python", "pnpm", "git", "harness"])(
  "native base tool %s rejects unknown/x64 even with fresh evidence; universal native images are allowed",
  (id) => {
    for (const arch of [null, "x64", "universal"] as const) {
      const { manifest, requirements } = fixture();
      const capability = manifest.capabilities[id];
      if (!capability) throw new Error("Missing fixture");
      capability.arch = arch;
      const combination = workerCombination(manifest, requirements.combination);
      for (const value of Object.values(manifest.capabilities))
        if (value.last_verified) value.last_verified.combination = combination;
      const failures = checkWorkerCapabilities(manifest, requirements);
      if (arch === "universal") expect(failures).toEqual([]);
      else expect(failures).toContain(`capability:${id}`);
    }
  },
);

test("explicit x64 runtime needs Rosetta evidence and cannot change native base tool requirements", () => {
  const { manifest, requirements } = fixture();
  const exemplar = manifest.capabilities.harness;
  if (!exemplar) throw new Error("Missing fixture");
  manifest.capabilities.runtime = {
    ...structuredClone(exemplar),
    version: "1.0.0",
    arch: "x64",
  };
  requirements.tools.runtime = { version: "1.0.0", arch: "x64" };
  const rebind = () => {
    const combination = workerCombination(manifest, requirements.combination);
    for (const value of Object.values(manifest.capabilities))
      if (value.last_verified) value.last_verified.combination = combination;
  };
  rebind();
  expect(checkWorkerCapabilities(manifest, requirements)).toContain(
    "capability:rosetta",
  );
  manifest.capabilities.rosetta = structuredClone(exemplar);
  rebind();
  expect(checkWorkerCapabilities(manifest, requirements)).toEqual([]);
  manifest.capabilities.rosetta.last_verified = null;
  expect(checkWorkerCapabilities(manifest, requirements)).toContain(
    "capability:rosetta",
  );
  requirements.tools.python = { version: "3.13.0", arch: "x64" };
  expect(checkWorkerCapabilities(manifest, requirements)).toContain(
    "tool_requirement",
  );
});
