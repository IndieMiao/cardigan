import { createHash } from "node:crypto";
import { expect, test } from "vitest";
import { compileAssignmentLaunch, parseLaunchConfig } from "./index.js";

// Frozen against the LP-2 compiler. Keep fixtures independent of role-pack text.
// Explicit argv/env and per-file digests cover even quoting, newlines and modes.
test.each(["claude-code", "codex", "pi"] as const)(
  "%s LP-2 launch parity",
  (harness) => {
    const result = compileAssignmentLaunch({
      assignment: { assignment_id: "A-1", run_id: "R-1" },
      launch: parseLaunchConfig({
        profiles: { selected: { harness, model: "example" } },
      }),
      role: {
        role_id: "coder",
        harness,
        launch_profile: "selected",
        core_prompt: "Fixture core",
        allowed_tools: ["whoami"],
        worktree: "write",
      },
      run_dir: "/fixture/run",
      work_dir: "/fixture/work",
      work_dir_real: "/fixture/work",
      mcp: { url: "https://example.invalid/mcp" },
      first_prompt: "Fixture first",
      secrets: {},
    });
    expect({
      ...result,
      files: result.files.map(({ content, ...file }) => ({
        ...file,
        sha256: createHash("sha256").update(content).digest("hex"),
      })),
    }).toMatchSnapshot();
  },
);
