import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProjectId } from "@cardigan/domain";
import { Store } from "@cardigan/store";
import { expect, test, vi } from "vitest";
import { webHarness } from "../../test-support/web.js";
import { project_id, seedWebProject } from "../../test-support/web-data.js";
import {
  NEEDS_PHASE_REFRESH_MS,
  needsClockPhase,
  readNeedsVersion,
} from "./needs-version.js";

test("source version observes committed cross-connection and global changes, isolates projects, and never builds command state", async () => {
  const root = await mkdtemp(join(tmpdir(), "needs-version-"));
  const store = Store.open({ dataDir: root });
  let other: Store | undefined;
  try {
    seedWebProject(store, root);
    const second = "second" as ProjectId;
    store.createProject({ id: second });
    const build = vi.fn();
    store.observe({ stateBuild: build });
    const version = () => readNeedsVersion(store, project_id, "boot/settings");
    const first = version();
    expect(version()).toBe(first);
    expect(readNeedsVersion(store, second, "boot/settings")).not.toBe(first);
    expect(readNeedsVersion(store, project_id, "new-boot/settings")).not.toBe(
      first,
    );
    expect(readNeedsVersion(store, project_id, "boot/new-settings")).not.toBe(
      first,
    );
    other = Store.open({ dataDir: root });
    const card = other.uow.read((tx) => tx.cards.list(project_id)[0]);
    if (!card) throw new Error("missing card");
    other.uow.run((tx) => tx.cards.put(project_id, { ...card, title: "new" }));
    const updated = version();
    expect(updated).not.toBe(first);
    expect(() =>
      other?.uow.run((tx) => {
        tx.cards.put(project_id, { ...card, title: "rollback" });
        throw new Error("rollback");
      }),
    ).toThrow("rollback");
    expect(version()).toBe(updated);
    other.uow.run((tx) =>
      tx.cards.put(second, { ...card, project_id: second }),
    );
    expect(version()).toBe(updated);
    other.uow.run((tx) => {
      const owner = tx.members.list()[0];
      if (!owner) throw new Error("missing owner");
      tx.members.put({ ...owner, name: "new owner" });
    });
    const identity = version();
    expect(identity).not.toBe(updated);
    other.uow.run((tx) =>
      tx.project_preferences.put(project_id, {
        id: project_id,
        auto_merge_after_minutes: null,
        pm_merge_confirmation: false,
      }),
    );
    expect(version()).not.toBe(identity);
    expect(build).not.toHaveBeenCalled();
  } finally {
    other?.close();
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("version preflight requires its own live session and full responses bind the same scope", async () => {
  const h = await webHarness({ password: "needs-version-password" });
  try {
    seedWebProject(h.store, h.dataDir);
    const path = `${h.server.url}/api/projects/${project_id}/needs-you`;
    expect((await fetch(`${path}/version`)).status).toBe(401);
    const cookie = await h.login("needs-version-password");
    const headers = { cookie };
    const response = await fetch(`${path}/version`, { headers });
    expect(response.headers.get("cache-control")).toBe("no-store");
    const first = (await response.json()) as {
      revision: string;
      read_scope: string;
    };
    expect(first.revision).toMatch(/^[a-f0-9]{64}$/);
    expect(first.read_scope).toMatch(/^[a-f0-9]{64}$/);
    const repeated = await fetch(`${path}/version`, { headers }).then((r) =>
      r.json(),
    );
    expect(repeated).toMatchObject({
      revision: first.revision,
      read_scope: first.read_scope,
    });
    const full = await fetch(path, { headers });
    expect(full.headers.get("x-cardigan-read-scope")).toBe(first.read_scope);
    const different = await h.login("needs-version-password");
    const second = (await fetch(`${path}/version`, {
      headers: { cookie: different },
    }).then((r) => r.json())) as typeof first;
    expect(second.revision).toBe(first.revision);
    expect(second.read_scope).not.toBe(first.read_scope);
    expect(
      (
        await fetch(`${path}/version`, {
          headers: { authorization: `Bearer ${first.read_scope}` },
        })
      ).status,
    ).toBe(401);
    const token = cookie.slice(cookie.indexOf("=") + 1);
    h.store.revokeWebSession(token);
    expect((await fetch(`${path}/version`, { headers })).status).toBe(401);
  } finally {
    await h.close();
  }
});

test("C-634 an unchanged project reuses its clock phase within the refresh span; data or a later clock recompute it", () => {
  const store = Store.open({ dbPath: ":memory:" });
  try {
    let computed = 0;
    const phase = (version: string | undefined, now: string) =>
      needsClockPhase(store, project_id, version, now, () => {
        computed++;
        return `${version}@${now}`;
      });
    const start = Date.parse("2030-01-01T00:00:00.000Z");
    const at = (ms: number) => new Date(start + ms).toISOString();
    expect(phase("v1", at(0))).toBe(`v1@${at(0)}`);
    expect(phase("v1", at(NEEDS_PHASE_REFRESH_MS - 1))).toBe(`v1@${at(0)}`);
    expect(computed).toBe(1);
    // Another project never shares the phase.
    needsClockPhase(store, "other" as ProjectId, "v1", at(1), () => "x");
    expect(phase("v1", at(2))).toBe(`v1@${at(0)}`);
    // A data change recomputes at once.
    expect(phase("v2", at(3))).toBe(`v2@${at(3)}`);
    // So does the end of the span, and a clock that moved backwards.
    expect(phase("v2", at(3 + NEEDS_PHASE_REFRESH_MS))).toBe(
      `v2@${at(3 + NEEDS_PHASE_REFRESH_MS)}`,
    );
    expect(phase("v2", at(0))).toBe(`v2@${at(0)}`);
    // Without a snapshot version nothing is reused.
    expect(phase(undefined, at(0))).toBe(`undefined@${at(0)}`);
    expect(phase(undefined, at(0))).toBe(`undefined@${at(0)}`);
    expect(computed).toBe(6);
  } finally {
    store.close();
  }
});
