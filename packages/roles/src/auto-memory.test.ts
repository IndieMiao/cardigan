import { expect, test } from "vitest";
import { compileAssignmentLaunch, parseLaunchConfig } from "./index.js";

test.each([false, true])(
  "S15 D7 disables automatic memory in every Claude Assignment launch (provider secrets=%s)",
  (credentials) => {
    const compiled = compileAssignmentLaunch({
      assignment: { assignment_id: "A-1", run_id: "R-2" },
      role: {
        role_id: "pm",
        harness: "claude-code",
        launch_profile: "fixture",
        core_prompt: "Fixed role",
        allowed_tools: ["whoami"],
        worktree: "none",
      },
      launch: parseLaunchConfig({
        providers: {
          gateway: {
            harness: "claude-code",
            secret_env: { ANTHROPIC_AUTH_TOKEN: "KEY" },
          },
        },
        profiles: {
          fixture: {
            harness: "claude-code",
            ...(credentials ? { provider: "gateway" } : {}),
          },
        },
      }),
      run_dir: "/fixture/runs/project/A-1",
      work_dir: "/fixture/runs/project/A-1",
      first_prompt: "fixture",
      mcp: { url: "http://localhost/mcp" },
      secrets: credentials ? { KEY: "fixture-secret" } : {},
    });
    const path = compiled.args[compiled.args.indexOf("--settings") + 1];
    const file = compiled.files.find((f) => f.path === path);
    expect(file).toBeDefined();
    expect(JSON.parse(file?.content ?? "{}")).toMatchObject({
      autoMemoryEnabled: false,
    });
    expect(file?.content).not.toContain("fixture-secret");
    // launch.sh only seeds missing state. Existing memories/settings are not deleted.
    expect(
      compiled.files.find((f) => f.path === compiled.launch_script)?.content,
    ).not.toContain("rm -rf");
  },
);
