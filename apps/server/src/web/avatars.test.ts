import { fileAvatarStore } from "@cardigan/store";
import { expect, test } from "vitest";
import { call, webHarness } from "../../test-support/web.js";

test("global avatar reads require login, have bitmap headers and revalidate even after logout", async () => {
  const harness = await webHarness({ password: "avatar-test-password" });
  try {
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
      "base64",
    );
    const ref = await fileAvatarStore(harness.dataDir).put(png);
    const sha256 = ref.slice(7);
    const path = `/api/avatars/${sha256}`;
    expect((await call(harness.port, path)).status).toBe(401);
    expect(
      (
        await call(harness.port, path, {
          headers: { authorization: "Bearer agent-token" },
        })
      ).status,
    ).toBe(401);
    const cookie = await harness.login("avatar-test-password");
    const response = await call(harness.port, path, { cookie });
    expect(response.status).toBe(200);
    expect(response.headers).toMatchObject({
      "content-type": "image/png",
      "content-length": String(png.length),
      "x-content-type-options": "nosniff",
      "cache-control": "private, no-cache",
      etag: `"${sha256}"`,
    });
    expect(response.body).toBe(png.toString("utf8"));
    const head = await call(harness.port, path, { cookie, method: "HEAD" });
    expect(head.status).toBe(200);
    expect(head.body).toBe("");
    expect(
      (
        await call(harness.port, path, {
          cookie,
          headers: { "if-none-match": `"${sha256}"` },
        })
      ).status,
    ).toBe(304);
    harness.store.setWebPassword("changed-avatar-password");
    expect(
      (
        await call(harness.port, path, {
          cookie,
          headers: { "if-none-match": `"${sha256}"` },
        })
      ).status,
    ).toBe(401);
  } finally {
    await harness.close();
  }
});

test("avatar routes reject missing hashes, traversal and non-read methods", async () => {
  const harness = await webHarness({ password: "avatar-test-password" });
  try {
    const cookie = await harness.login("avatar-test-password");
    for (const path of [
      "/api/avatars/",
      "/api/avatars/../secret",
      "/api/avatars/%2e%2e%2fsecret",
      "/api/avatars/%2fetc%2fpasswd",
      "/api/avatars/..%5csecret",
      "/api/avatars/%00",
      `/api/avatars/${"a".repeat(64)}.png`,
      `/api/avatars/${"a".repeat(64)}`,
    ])
      expect((await call(harness.port, path, { cookie })).status, path).toBe(
        404,
      );
    expect(
      (
        await call(harness.port, `/api/avatars/${"a".repeat(64)}`, {
          cookie,
          method: "POST",
          headers: { origin: `http://${harness.hostHeader}` },
        })
      ).status,
    ).toBe(405);
  } finally {
    await harness.close();
  }
});
