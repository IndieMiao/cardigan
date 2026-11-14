import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setProjectPreferences } from "@cardigan/domain";
import { loadCommandState, persistEffect } from "@cardigan/mcp-server";
import { Store } from "@cardigan/store";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { type CardiganServer, startCardiganServer } from "./server.js";
import {
  profileTick,
  setTickProfiler,
  setTickProfileSync,
  tickProfiler,
} from "./tick-profile.js";

/**
 * C-265: the server reads the human's `tick_profile` preference at the start
 * of every loop tick; no restart is needed to turn measurement on or off.
 */
let dataDir: string;
let store: Store;
let server: CardiganServer | undefined;
let stdout: string[];

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "cardigan-tick-switch-"));
  store = Store.open({ dataDir });
  store.createProject({ id: "p-tick", name: "Tick" });
  stdout = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    stdout.push(String(chunk));
    return true;
  });
});
afterEach(async () => {
  await server?.close();
  server = undefined;
  vi.restoreAllMocks();
  setTickProfiler(undefined);
  setTickProfileSync(undefined);
  store.close();
  rmSync(dataDir, { recursive: true, force: true });
});

const start = (env: Record<string, string> = {}) =>
  startCardiganServer({
    config: { dataDir, host: "127.0.0.1", port: 0 },
    store,
    env: { CARDIGAN_RUNTIME_MODE: "local", ...env },
    warn: () => {},
    log: () => {},
  });

function setSwitch(on: boolean) {
  store.uow.run((tx) => {
    const result = setProjectPreferences(
      loadCommandState(tx, "p-tick"),
      { kind: "human", project_id: "p-tick" },
      { tick_profile: on },
      { clock: { now: () => new Date().toISOString() }, ids: tx.ids },
    );
    if (!result.ok) throw new Error(result.error.message);
    persistEffect(tx, "p-tick", result.value);
  });
}

const tickLines = () =>
  stdout
    .flatMap((chunk) => chunk.split("\n"))
    .filter((line) => line.includes('"tick_profile"'))
    .map((line) => JSON.parse(line) as Record<string, unknown>);

test("without the switch the server installs no profiler and logs no tick lines", async () => {
  server = await start();
  await profileTick("dispatcher", async () => undefined);
  expect(tickProfiler()).toBeUndefined();
  expect(tickLines()).toEqual([]);
});

test("the human's switch turns measurement on and off at the next tick, without a restart", async () => {
  server = await start();
  await profileTick("dispatcher", async () => undefined);
  expect(tickLines()).toEqual([]);

  setSwitch(true);
  await profileTick("dispatcher", async () => {
    // Store work inside the tick is attributed to it.
    store.uow.read(() => undefined);
  });
  const [line] = tickLines();
  expect(line).toMatchObject({ event: "tick_profile", loop: "dispatcher" });
  expect(line?.uow_count).toBeGreaterThanOrEqual(1);
  expect(typeof line?.ts).toBe("string");
  expect(String(line?.sha)).toMatch(/^(?:[0-9a-f]{40}|unknown)$/u);

  setSwitch(false);
  await profileTick("dispatcher", async () => undefined);
  expect(tickProfiler()).toBeUndefined();
  expect(tickLines()).toHaveLength(1);

  await server.close();
  server = undefined;
  // A closed server no longer reacts to the switch.
  setSwitch(true);
  await profileTick("dispatcher", async () => undefined);
  expect(tickProfiler()).toBeUndefined();
  expect(tickLines()).toHaveLength(1);
});

test("CARDIGAN_TICK_PROFILE=1 still forces measurement with the switch off", async () => {
  server = await start({ CARDIGAN_TICK_PROFILE: "1" });
  expect(tickProfiler()).toBeDefined();
  await profileTick("cleanup", async () => undefined);
  expect(tickLines()).toHaveLength(1);
  await server.close();
  server = undefined;
  expect(tickProfiler()).toBeUndefined();
});
