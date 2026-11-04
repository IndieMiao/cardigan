import { expect, test } from "vitest";
import { withTempStore } from "./test-support.js";

test("createProject records a project once", () => {
  withTempStore((store) => {
    const created = store.createProject({
      id: "p-fictional",
      name: "Fictional",
    });
    expect(created).toMatchObject({
      ok: true,
      value: { id: "p-fictional", name: "Fictional" },
    });
    expect(store.getProject("p-fictional")).toMatchObject({
      id: "p-fictional",
      name: "Fictional",
    });
    expect(store.listProjects().map((project) => project.id)).toEqual([
      "p-fictional",
    ]);
  });
});

test("createProject defaults the name to the id", () => {
  withTempStore((store) => {
    expect(store.createProject({ id: "p-a" })).toMatchObject({
      ok: true,
      value: { name: "p-a" },
    });
  });
});

test("createProject refuses to overwrite an existing project", () => {
  withTempStore((store) => {
    store.createProject({ id: "p-a", name: "First" });
    const again = store.createProject({ id: "p-a", name: "Second" });

    expect(again.ok).toBe(false);
    expect(again.ok === false && again.error.code).toBe("validation_failed");
    expect(store.getProject("p-a")?.name).toBe("First");
  });
});

test("projects are ordered by creation time", () => {
  let tick = 0;
  const clock = { now: () => `2026-01-01T00:00:0${tick}.000Z` };
  withTempStore(
    (store) => {
      store.createProject({ id: "p-late" });
      tick = 1;
      store.createProject({ id: "p-early" });
      expect(store.listProjects().map((project) => project.id)).toEqual([
        "p-late",
        "p-early",
      ]);
    },
    { clock },
  );
});

test("an unknown project is undefined", () => {
  withTempStore((store) => {
    expect(store.getProject("p-missing")).toBeUndefined();
  });
});

test("a fresh store has no projects", () => {
  withTempStore((store) => {
    expect(store.listProjects()).toEqual([]);
  });
});
