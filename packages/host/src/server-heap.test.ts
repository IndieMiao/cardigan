import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, test } from "vitest";
import {
  DEFAULT_SERVER_HEAP_MB,
  MAX_SERVER_HEAP_MB,
  MIN_SERVER_HEAP_MB,
  serverHeap,
} from "./server-heap.js";

const exec = promisify(execFile);

describe("C-785 server heap limit", () => {
  test("defaults to a raised limit and keeps other NODE_OPTIONS", () => {
    expect(serverHeap({})).toEqual({
      node_options: `--max-old-space-size=${DEFAULT_SERVER_HEAP_MB}`,
      heap_mb: DEFAULT_SERVER_HEAP_MB,
      source: "default",
    });
    expect(
      serverHeap({ NODE_OPTIONS: " --enable-source-maps " }).node_options,
    ).toBe(
      `--enable-source-maps --max-old-space-size=${DEFAULT_SERVER_HEAP_MB}`,
    );
  });

  test("a host override in MiB is used within bounds", () => {
    expect(serverHeap({ CARDIGAN_SERVER_HEAP_MB: "12288" })).toEqual({
      node_options: "--max-old-space-size=12288",
      heap_mb: 12288,
      source: "env",
    });
    for (const value of [MIN_SERVER_HEAP_MB, MAX_SERVER_HEAP_MB])
      expect(
        serverHeap({ CARDIGAN_SERVER_HEAP_MB: String(value) }).heap_mb,
      ).toBe(value);
  });

  test("an unusable override keeps the default and says so", () => {
    for (const raw of [
      "abc",
      "8g",
      "-1",
      "1.5",
      String(MIN_SERVER_HEAP_MB - 1),
      String(MAX_SERVER_HEAP_MB + 1),
    ]) {
      const heap = serverHeap({ CARDIGAN_SERVER_HEAP_MB: raw });
      expect(heap.heap_mb).toBe(DEFAULT_SERVER_HEAP_MB);
      expect(heap.source).toBe("default");
      expect(heap.warning).toContain("CARDIGAN_SERVER_HEAP_MB");
    }
    expect(
      serverHeap({ CARDIGAN_SERVER_HEAP_MB: " " }).warning,
    ).toBeUndefined();
  });

  test("a limit already in the host NODE_OPTIONS wins unchanged", () => {
    for (const [options, mb] of [
      ["--max-old-space-size=6144", 6144],
      ["--trace-warnings --max_old_space_size=7000", 7000],
      ["--max-old-space-size=2048 --max-old-space-size=3072", 3072],
    ] as const)
      expect(
        serverHeap({ NODE_OPTIONS: options, CARDIGAN_SERVER_HEAP_MB: "16384" }),
      ).toEqual({ node_options: options, heap_mb: mb, source: "node_options" });
  });

  test("node applies the value to the main thread and its workers", async () => {
    const script = `
      const { Worker } = require('node:worker_threads');
      const v8 = require('node:v8');
      const main = v8.getHeapStatistics().heap_size_limit;
      new Worker("require('node:worker_threads').parentPort.postMessage(require('node:v8').getHeapStatistics().heap_size_limit)", { eval: true })
        .once('message', (worker) => { console.log(JSON.stringify({ main, worker })); process.exit(0); });`;
    const { stdout } = await exec(process.execPath, ["-e", script], {
      env: {
        PATH: process.env.PATH,
        NODE_OPTIONS: serverHeap({ CARDIGAN_SERVER_HEAP_MB: "6144" })
          .node_options,
      },
    });
    const { main, worker } = JSON.parse(stdout) as {
      main: number;
      worker: number;
    };
    // heap_size_limit adds the young generation on top of old space.
    expect(main).toBeGreaterThanOrEqual(6144 * 2 ** 20);
    expect(main).toBeLessThan(6144 * 2 ** 20 + 512 * 2 ** 20);
    expect(worker).toBe(main);
  });
});
