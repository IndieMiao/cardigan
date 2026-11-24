import { USAGE_NOTE_MAX_LENGTH } from "@cardigan/domain";
import { listCapabilityGuides } from "@cardigan/store";
import { expect, test } from "vitest";
import { m5Cross, TEST_PASSWORD } from "../../test-support/m5-cross.js";

test("human session reads and writes usage notes; any Agent Token gets 403", async () => {
  const f = await m5Cross();
  try {
    const path = f.projectPath("/capability-guides");
    const bearer = { authorization: `Bearer ${f.token(f.primary.owner)}` };
    const note = {
      scope: "capability",
      key: "android.emulator",
      usage_note: "用 `emulator -list-avds` 查看",
    };
    // Bearer alone, before any login: refused, not asked to log in.
    for (const method of ["GET", "PUT", "DELETE"])
      expect(
        (
          await f.call(path, {
            method,
            headers: bearer,
            anonymous: true,
            ...(method === "GET" ? {} : { body: note }),
          })
        ).status,
      ).toBe(403);
    expect((await f.call(path, { anonymous: true })).status).toBe(401);

    await f.password(TEST_PASSWORD);
    await f.login();
    // A logged-in browser that also carries a Bearer is still refused.
    expect(
      (await f.call(path, { method: "PUT", body: note, headers: bearer }))
        .status,
    ).toBe(403);
    expect(listCapabilityGuides(f.store(), f.project.project_id)).toEqual([]);

    expect((await f.call(path, { method: "PUT", body: note })).status).toBe(
      200,
    );
    expect(
      (
        await f.call(path, {
          method: "PUT",
          body: {
            scope: "machine",
            key: "android.emulator",
            machine_id: "mac-mini",
            usage_note: "ANDROID_AVD_HOME=~/.android/avd",
          },
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await f.call(path, {
          method: "PUT",
          body: {
            scope: "project",
            key: "signing",
            usage_note: "签名走 request_mobile_signature",
          },
        })
      ).status,
    ).toBe(200);
    const read = await f.call(`${path}?machine=mac-mini`);
    expect(read.status).toBe(200);
    expect(read.json).toMatchObject({
      entries: expect.any(Array),
      merged: {
        machine_id: "mac-mini",
        capabilities: [
          {
            key: "android.emulator",
            usage_note: "用 `emulator -list-avds` 查看",
            machine_note: "ANDROID_AVD_HOME=~/.android/avd",
          },
        ],
        project_notes: [
          { key: "signing", usage_note: "签名走 request_mobile_signature" },
        ],
      },
    });

    const refused = await f.call(path, {
      method: "PUT",
      body: { ...note, usage_note: "password: hunter22" },
    });
    expect(refused.status).toBe(400);
    expect(refused.text).toContain("看起来包含凭据");
    expect(refused.text).not.toContain("hunter22");
    expect(
      (
        await f.call(path, {
          method: "PUT",
          body: { ...note, usage_note: "x".repeat(USAGE_NOTE_MAX_LENGTH + 1) },
        })
      ).status,
    ).toBe(400);
    expect(
      (await f.call(path, { method: "PUT", body: { ...note, extra: 1 } }))
        .status,
    ).toBe(400);
    expect((await f.call(path, { method: "POST", body: note })).status).toBe(
      405,
    );

    const target = { scope: "project", key: "signing" };
    expect(
      (await f.call(path, { method: "DELETE", body: target })).status,
    ).toBe(200);
    expect(
      (await f.call(path, { method: "DELETE", body: target })).status,
    ).toBe(404);
    expect(
      listCapabilityGuides(f.store(), f.project.project_id).map((e) => [
        e.scope,
        e.key,
        e.machine_id,
        e.usage_note,
      ]),
    ).toEqual([
      ["capability", "android.emulator", null, "用 `emulator -list-avds` 查看"],
      [
        "machine",
        "android.emulator",
        "mac-mini",
        "ANDROID_AVD_HOME=~/.android/avd",
      ],
    ]);
  } finally {
    await f.close();
  }
});
