import { expect, test } from "vitest";
import { m5Cross, TEST_PASSWORD } from "../../test-support/m5-cross.js";

test("C-778: only the human session transfers the primary slot; refusals write nothing and replays return the original", async () => {
  const f = await m5Cross();
  try {
    const owner = f.primary.owner;
    if (owner.scope !== "work_item") throw new Error("missing producer");
    const redo = await f.extra();
    if (redo.owner.scope !== "work_item") throw new Error("missing redo");
    const path = f.projectPath(
      `/work-items/${owner.work_item_id}/replace-primary`,
    );
    const body = {
      replacement_work_item_id: redo.owner.work_item_id,
      card_id: f.card.id,
      template_key: "development",
      reason: "派错角色",
    };
    const post = (
      input: object,
      key: string | undefined,
      extra: Record<string, unknown> = {},
    ) =>
      f.call(path, {
        method: "POST",
        body: input,
        headers: key === undefined ? {} : { "idempotency-key": key },
        ...extra,
      });
    const items = () =>
      JSON.stringify(
        f.state().work_items.filter((w) => w.card_id === f.card.id),
      );
    const before = items();
    expect((await post(body, "anonymous")).status).toBe(401);
    await f.password(TEST_PASSWORD);
    await f.login();
    const token = f.token(owner);
    expect(
      (
        await post(body, "agent", {
          anonymous: true,
          headers: {
            authorization: `Bearer ${token}`,
            "idempotency-key": "agent",
          },
        })
      ).status,
    ).toBe(401);
    expect((await post(body, undefined)).status).toBe(400);
    expect((await post({ ...body, extra: true }, "strict")).status).toBe(400);
    // The mis-assigned producer still holds an active Assignment.
    const active = await post(body, "active");
    expect(active.status).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(active.json)).toContain("未释放的 Assignment");
    expect(items()).toBe(before);

    f.release(owner);
    const moved = await post(body, "move");
    expect(moved.status).toBe(200);
    expect(moved.json).toMatchObject({
      id: redo.owner.work_item_id,
      template_key: "development",
      required: true,
    });
    expect((await post(body, "move")).json).toEqual(moved.json);
    expect((await post(body, "again")).status).toBeGreaterThanOrEqual(400);
    const retired = f
      .state()
      .work_items.find((w) => w.id === owner.work_item_id);
    expect(retired).toMatchObject({
      status: "cancelled",
      replaced_by_work_item_id: redo.owner.work_item_id,
    });
    expect(
      f.state().events.filter((e) => e.type === "primary_work_item_replaced"),
    ).toMatchObject([{ actor: { kind: "human" } }]);
  } finally {
    await f.close();
  }
});
