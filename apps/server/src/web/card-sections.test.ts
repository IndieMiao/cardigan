import { expect, test } from "vitest";
import { call, webHarness } from "../../test-support/web.js";
import { project_id, seedWebProject } from "../../test-support/web-data.js";

test("overview preserves the head, page and counts; each panel returns only its contract", async () => {
  const f = await webHarness({ password: "synthetic-panel-test" });
  try {
    seedWebProject(f.store, f.dataDir);
    const cookie = await f.login("synthetic-panel-test");
    const path = `/api/projects/${project_id}/cards/C-1?limit=1`;
    const get = async (section = "") => {
      const res = await call(
        f.port,
        `${path}${section && `&section=${section}`}`,
        { cookie },
      );
      expect(res.status).toBe(200);
      return JSON.parse(res.body);
    };
    const full = await get();
    const overview = await get("overview");
    for (const key of [
      "work_items",
      "deliveries",
      "reviews",
      "review_matrix",
      "attachments",
    ])
      expect(overview).not.toHaveProperty(key);
    for (const key of [
      "card",
      "timeline",
      "timeline_next_cursor",
      "counts",
      "recent_conclusions",
    ])
      expect(overview[key]).toEqual(full[key]);
    expect(overview.overview).toMatchObject({
      work_count: full.work_items.length,
      attachment_count: full.attachments.length,
    });
    expect((await get("work")).work_items).toEqual(full.work_items);
    expect(await get("attachments")).toEqual({
      project_id,
      attachments: full.attachments,
    });
    expect(await get("records")).toEqual({
      project_id,
      deliveries: full.deliveries,
      reviews: full.reviews,
      review_matrix: full.review_matrix,
    });
    expect(
      (await call(f.port, `${path}&section=unknown`, { cookie })).status,
    ).toBe(400);
    expect((await call(f.port, `${path}&section=records`)).status).toBe(401);
  } finally {
    await f.close();
  }
});
