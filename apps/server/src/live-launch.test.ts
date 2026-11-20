import { chmodSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { RuntimeTargets } from "@cardigan/host";
import { isAcceptedBrowserPath } from "@cardigan/store";
import { afterEach, expect, test, vi } from "vitest";
import { dispatchFixture } from "../test-support/dispatch.js";
import { createHostWiring } from "./host.js";
import { startQueuedRun } from "./host-start.js";

vi.mock("./host-start.js", () => ({ startQueuedRun: vi.fn() }));
vi.mock("@cardigan/host", async (load) => ({
  ...(await load<typeof import("@cardigan/host")>()),
  agentCliVersion: async () => "pi fixture",
}));
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

test("each new snapshot reads hot edits; an in-flight start retains its whole generation and an invalid pair raises a content-free notice", async () => {
  const f = dispatchFixture();
  try {
    const yaml = join(f.dataDir, "launch.yaml"),
      secrets = join(f.dataDir, "secrets.env");
    const config = (id: string) =>
      JSON.stringify({
        ...(id === "fixed"
          ? {}
          : {
              browser: {
                command: "/fixture/mcp",
                browsers_path: `/fixture/${id}`,
              },
            }),
        providers: { relay: { harness: "pi", secret_env: { TOKEN: "KEY" } } },
        models: { alias: { id, provider: "relay", context_window: 4096 } },
        profiles: { fixture: { harness: "pi", model: "alias" } },
      });
    writeFileSync(yaml, config("old"));
    writeFileSync(secrets, "KEY=fixture-before", { mode: 0o600 });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({})),
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { assignment } = f.create();
    const execution = { mode: "local" as const, dataDir: f.dataDir };
    vi.spyOn(RuntimeTargets.prototype, "forLaunch").mockResolvedValue({
      execution,
    } as Awaited<ReturnType<RuntimeTargets["forLaunch"]>>);
    const host = await createHostWiring({
      env: { CARDIGAN_CONFIG_DIR: f.dataDir },
      store: f.store,
      dataDir: f.dataDir,
      execution,
    });
    const take = () => host.snapshot(assignment, f.project);
    const first = await take();
    expect(first.model).toBe("old");
    expect(isAcceptedBrowserPath(f.store, "/fixture/old")).toBe(true);
    writeFileSync(`${yaml}.tmp`, config("new"));
    renameSync(`${yaml}.tmp`, yaml);
    writeFileSync(secrets, "KEY=fixture-after");
    const second = await take();
    expect(second.model).toBe("new");
    expect(host.upstream.profiles.fixture?.model).toBe("new");
    for (const snapshot of [first, second])
      await host.startRun({
        project: f.project,
        assignment,
        run: f.session(assignment),
        bell: "fixture",
        snapshot,
      });
    expect(
      vi
        .mocked(startQueuedRun)
        .mock.calls.map(([host]) => [
          host.launch.config.profiles.fixture?.model,
          host.launch.secrets.KEY,
        ]),
    ).toEqual([
      ["old", "fixture-before"],
      ["new", "fixture-after"],
    ]);
    chmodSync(secrets, 0o644);
    writeFileSync(yaml, config("unsafe"));
    expect((await take()).model).toBe("new");
    expect((await take()).model).toBe("new");
    expect(
      f.state().events.filter((e) => e.type === "launch_reload_failed"),
    ).toHaveLength(1);
    expect(isAcceptedBrowserPath(f.store, "/fixture/unsafe")).toBe(false);
    expect(isAcceptedBrowserPath(f.store, "/fixture/new")).toBe(true);
    chmodSync(secrets, 0o600);
    writeFileSync(yaml, "profiles: [private-marker");
    await host.refreshLaunch();
    expect(host.upstream.profiles.fixture?.model).toBe("new");
    expect(JSON.stringify(f.state().events)).not.toContain("private-marker");
    expect(warn.mock.calls.flat().join(" ")).not.toContain("private-marker");
    writeFileSync(yaml, config("fixed"));
    expect((await take()).model).toBe("fixed");
    expect(isAcceptedBrowserPath(f.store, "/fixture/new")).toBe(false);
  } finally {
    f.close();
  }
});
