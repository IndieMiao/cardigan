import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Actor, CardId, Event, Precheck } from "@cardigan/domain";
import { afterEach, beforeEach, expect, test } from "vitest";
import { call, type WebHarness, webHarness } from "../../test-support/web.js";
import {
  NOW,
  project_id,
  seedWebProject,
} from "../../test-support/web-data.js";

let h: WebHarness, cookie: string;
const attempt = "06GYDF22VAN4WMAVRJ9XKPB514";
const path = (suffix: string) => `/api/projects/${project_id}${suffix}`;
const log = path(`/prechecks/${attempt}`);
const check: Precheck = {
  attempt_id: attempt,
  card_id: "C-2" as CardId,
  assignment_id: "A-1" as Precheck["assignment_id"],
  work_item_id: "W-2" as Precheck["work_item_id"],
  branch: "feat/display",
  machine_id: "fixture",
  head_sha: "a".repeat(40),
  status: "queued",
};
function record(
  type: Event["type"],
  at: string,
  actor: Actor = { kind: "system", project_id },
) {
  h.store.uow.run((tx) =>
    tx.events.append(project_id, {
      id: tx.ids.nextEventId(),
      seq: tx.ids.nextEventSequence(project_id, check.card_id),
      card_id: check.card_id,
      type,
      actor,
      created_at: at,
      payload: {
        ...check,
        status: type === "precheck_finished" ? "passed" : "queued",
        log_ref: `${attempt}.log`,
      },
    }),
  );
}
beforeEach(async () => {
  h = await webHarness({ password: "display-test-password" });
  seedWebProject(h.store, h.dataDir);
  cookie = await h.login("display-test-password");
});
afterEach(async () => h.close());

test("precheck display time comes from its last system event independently of timeline pagination", async () => {
  record("precheck_queued", NOW);
  const finished = "2026-01-01T00:05:00.000Z";
  record("precheck_finished", finished);
  record("precheck_finished", "2026-01-01T00:06:00.000Z", {
    kind: "human",
    project_id,
  });
  const response = await call(h.port, path("/cards/C-2?limit=1"), { cookie });
  expect(response.status).toBe(200);
  expect(response.json).toMatchObject({
    card: {
      prechecks: [
        { head_sha: check.head_sha, updated_at: finished, status: "passed" },
      ],
    },
  });
});

test("precheck log requires a live human session and a same-project system precheck", async () => {
  const directory = join(h.dataDir, "merge-gate", "logs", project_id);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, `${attempt}.log`), "passed fixture log");
  expect((await call(h.port, log)).status).toBe(401);
  expect((await call(h.port, log, { cookie })).status).toBe(404);
  record("precheck_finished", NOW, { kind: "human", project_id });
  expect((await call(h.port, log, { cookie })).status).toBe(404);
  record("precheck_finished", NOW);
  const response = await call(h.port, log, { cookie });
  expect(response.status).toBe(200);
  expect(response.body).toContain("passed fixture log");
  expect(response.body).toContain(check.head_sha);
  expect(response.body).not.toContain("仍需正式审核");
  expect(response.headers["content-security-policy"]).toContain("sandbox");
  expect(
    (await call(h.port, `/api/projects/other/prechecks/${attempt}`, { cookie }))
      .status,
  ).toBe(404);
  h.store.setWebPassword("replacement-password");
  expect((await call(h.port, log, { cookie })).status).toBe(401);
});

test("precheck log never accepts path components or unrecorded attempts", async () => {
  record("precheck_finished", NOW);
  for (const value of [
    "../secret",
    "%2e%2e%2fsecret",
    `${attempt}.log`,
    "a".repeat(81),
    "unknown",
  ]) {
    expect([400, 404]).toContain(
      (await call(h.port, path(`/prechecks/${value}`), { cookie })).status,
    );
  }
});
