import { expect, test } from "vitest";
import { ApiError, describeError, HttpCardiganClient } from "./api.js";

const sessionFetch = (body: unknown) =>
  (async () =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;

test("the session read carries the host attachment limit for the comment box", async () => {
  const client = new HttpCardiganClient(
    sessionFetch({
      authenticated: true,
      password_configured: true,
      read_scope: "a".repeat(64),
      attachment_max_bytes: 30 * 1024 * 1024,
    }),
  );
  expect(client.attachmentMaxBytes()).toBeUndefined();
  await client.session();
  expect(client.attachmentMaxBytes()).toBe(30 * 1024 * 1024);
});

test.each([undefined, 0, -1, 1.5, "30"])(
  "an absent or invalid limit %j leaves the server to decide",
  async (value) => {
    const client = new HttpCardiganClient(
      sessionFetch({
        authenticated: true,
        password_configured: true,
        attachment_max_bytes: value,
      }),
    );
    await client.session();
    expect(client.attachmentMaxBytes()).toBeUndefined();
  },
);

test("the server's over-limit refusal is shown in Chinese with the limit", () => {
  expect(
    describeError(
      new ApiError(413, "payload_too_large", "Attachment exceeds 30 MiB"),
    ),
  ).toBe("请求失败：附件超过 30 MiB");
});
