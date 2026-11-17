import { expect, test, vi } from "vitest";
import { call, webHarness } from "../../test-support/web.js";
import { project_id, seedWebProject } from "../../test-support/web-data.js";

test("execution diagnostic uses human project access; bearer and unknown projects cannot trigger observation", async () => {
  const result = {
    configuration: [
      {
        profile: "fixture",
        code: "codex_approval",
        message: "审批策略可能等待交互确认",
      },
    ],
    sessions: [
      {
        assignment_id: "A-1" as never,
        cause: "waiting_confirmation" as const,
        action: "wait" as const,
        evidence: ["current_runtime_observation"],
      },
    ],
  };
  const read = vi.fn(async () => result);
  const f = await webHarness({
    password: "fixture-password",
    executionDiagnostics: read,
  });
  try {
    seedWebProject(f.store, f.dataDir);
    const path = `/api/projects/${project_id}/execution/diagnostics`;
    expect(
      (
        await call(f.port, path, {
          headers: { authorization: "Bearer synthetic-secret" },
        })
      ).status,
    ).toBe(401);
    expect(read).not.toHaveBeenCalled();
    const cookie = await f.login("fixture-password");
    expect(
      (
        await call(f.port, "/api/projects/missing/execution/diagnostics", {
          cookie,
        })
      ).status,
    ).toBe(404);
    expect(read).not.toHaveBeenCalled();
    const response = await call(f.port, path, { cookie });
    expect(response.status).toBe(200);
    expect(response.json).toEqual(result);
    expect(read).toHaveBeenCalledWith(project_id);
    expect(response.headers["cache-control"]).toContain("no-store");
  } finally {
    await f.close();
  }
});
