import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cpuProfileCommand } from "@cardigan/host";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { stubGit } from "./git-test-support.js";
import { type CardiganServer, startCardiganServer } from "./server.js";
import * as tickProfile from "./tick-profile.js";
import { resolveWebConfig } from "./web/config.js";

let root: string;
let server: CardiganServer | undefined;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "cpu-server-"));
  vi.spyOn(tickProfile, "releaseSha").mockReturnValue("c".repeat(40));
});
afterEach(async () => {
  await server?.close();
  server = undefined;
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});
const runtime = {
  status: async () => ({
    ok: true,
    value: { process: "alive", agent: "idle", observed_seq: 1 },
  }),
  wake: async () => ({ ok: true, value: { sent: true } }),
  release: async () => ({ ok: true, value: undefined }),
  async *events() {},
} as never;

test.each(["web", "background"] as const)(
  "%s consumes at its existing boundary and close awaits complete publication",
  async (role) => {
    server = await startCardiganServer({
      role,
      config: { dataDir: root, host: "127.0.0.1", port: 0 },
      env: { CARDIGAN_RUNTIME_MODE: "local" },
      warn: () => {},
      log: () => {},
      ...(role === "web"
        ? {
            web: {
              config: resolveWebConfig({}, { port: 0, staticDir: root }),
              log: () => {},
            },
          }
        : {
            git: stubGit(),
            dispatcher: {
              runtime,
              snapshot: async () => ({
                model: "synthetic",
                agent_cli_version: "synthetic",
              }),
              startRun: async () => {},
            },
          }),
    });
    const directory = join(root, "cpu-profiles", role);
    expect(
      readdirSync(directory).filter((n) => n.endsWith(".cpuprofile")),
    ).toEqual([]);
    cpuProfileCommand({
      dataDir: root,
      action: "start",
      target: role,
      seconds: 1,
    });
    if (role === "web") await fetch(`${server.web?.url}/api/session`);
    else await tickProfile.profileTick("fixture", async () => {});
    await vi.waitFor(() =>
      expect(
        JSON.parse(readFileSync(join(directory, "state.json"), "utf8")).phase,
      ).toBe("recording"),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    await server.close();
    server = undefined;
    const names = readdirSync(directory).filter((n) =>
      n.endsWith(".cpuprofile"),
    );
    expect(names).toHaveLength(1);
    const profile = JSON.parse(
      readFileSync(join(directory, names[0] as string), "utf8"),
    );
    expect(profile.nodes.length).toBeGreaterThan(0);
    expect(profile.endTime).toBeGreaterThan(profile.startTime);
    expect(readdirSync(directory).some((n) => n.startsWith("partial-"))).toBe(
      false,
    );
  },
);

test("unknown release identity disables optional recording while requests retain old behavior", async () => {
  vi.mocked(tickProfile.releaseSha).mockReturnValue("unknown");
  server = await startCardiganServer({
    role: "web",
    config: { dataDir: root, host: "127.0.0.1", port: 0 },
    env: { CARDIGAN_RUNTIME_MODE: "local" },
    warn: () => {},
    log: () => {},
  });
  expect((await fetch(server.url)).status).not.toBe(500);
  expect(existsSync(join(root, "cpu-profiles"))).toBe(false);
});
