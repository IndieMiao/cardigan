import { expect, test, vi } from "vitest";
import { call, webHarness } from "../../test-support/web.js";
import { project_id, seedWebProject } from "../../test-support/web-data.js";

test("Workbench logs one duration and fixed route per read/write/error without request secrets", async () => {
  const entries: Readonly<Record<string, unknown>>[] = [];
  const password = "fictional-password-for-log-test";
  const avatarId = "a".repeat(64);
  const f = await webHarness({ password, log: (event) => entries.push(event) });
  try {
    seedWebProject(f.store, f.dataDir);
    const cookie = await f.login(password);
    const request = async (path: string, method = "GET", body?: string) => {
      const before = entries.length;
      const response = await call(f.port, path, {
        method,
        cookie,
        ...(body === undefined ? {} : { body }),
        headers: {
          origin: f.server.url,
          "content-type": "application/json",
          authorization: "Bearer fictional-secret",
          "x-request-id": "header-secret",
        },
      });
      expect(entries).toHaveLength(before + 1);
      expect(entries.at(-1)).toMatchObject({
        event: "web_http",
        method,
        status: response.status,
        duration_ms: expect.any(Number),
        timestamp: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
        role: "web",
        pid: process.pid,
        request_id: expect.any(String),
        phases_ms: {
          to_headers: expect.any(Number),
          response: expect.any(Number),
        },
      });
      expect(entries.at(-1)?.duration_ms).toBeGreaterThanOrEqual(0);
      return entries.at(-1);
    };
    expect(
      await request(`/api/projects/${project_id}/cards/C-1?token=query-secret`),
    ).toMatchObject({
      route: "/api/projects/:project_id/cards/:id",
      code: "ok",
      status: 200,
    });
    expect(
      await request(
        `/api/projects/${project_id}/cards/C-1/comments?token=query-secret`,
        "POST",
        JSON.stringify({ body: "body-secret" }),
      ),
    ).toMatchObject({
      route: "/api/projects/:project_id/cards/:id/comments",
      status: 200,
    });
    expect(
      await request(
        `/api/projects/${project_id}/cards/version?token=query-secret`,
      ),
    ).toMatchObject({
      route: "/api/projects/:project_id/cards/version",
      status: 200,
    });
    expect(
      await request(`/api/projects/${project_id}/cards?filter=query-secret`),
    ).toMatchObject({
      route: "/api/projects/:project_id/cards",
      code: "validation_failed",
      status: 400,
    });
    expect(await request("/api/path-secret?token=query-secret")).toMatchObject({
      route: "unmatched",
      status: 404,
    });
    expect(
      await request(
        `/api/projects/${project_id}/preferences?token=query-secret`,
      ),
    ).toMatchObject({
      route: "/api/projects/:project_id/preferences",
      status: 200,
    });
    expect(
      await request(`/api/avatars/${avatarId}?token=query-secret`),
    ).toMatchObject({
      route: "/api/avatars/:sha256",
      code: "not_found",
      status: 404,
    });
    const spy = vi
      .spyOn(f.store.database, "prepare")
      .mockImplementationOnce(() => {
        throw new Error("error-secret");
      });
    try {
      expect(await request(`/api/projects/${project_id}/cards`)).toMatchObject({
        code: "internal_error",
        status: 500,
      });
    } finally {
      spy.mockRestore();
    }
    const logs = JSON.stringify(entries);
    for (const secret of [
      password,
      cookie,
      "fictional-secret",
      "header-secret",
      "query-secret",
      "body-secret",
      "path-secret",
      "error-secret",
      avatarId,
    ])
      expect(logs).not.toContain(secret);
    expect(entries[0]).toMatchObject({
      route: "/api/login",
      method: "POST",
      duration_ms: expect.any(Number),
      status: 200,
    });
  } finally {
    await f.close();
  }
});
