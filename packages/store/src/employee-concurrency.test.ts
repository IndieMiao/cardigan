import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { expect, test } from "vitest";
import { Store } from "./store.js";

test("independent SQLite writers cannot create two employees for one character", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "cardigan-employee-race-"));
  Store.open({ dataDir }).close();
  const workers: Worker[] = [];
  try {
    const ready: Promise<void>[] = [];
    const results = ["第一位", "第二位"].map((name) => {
      const worker = new Worker(
        `
        const { parentPort, workerData } = require('node:worker_threads');
        (async () => {
          const { Store, persistEmployeeEffect } = await import(workerData.store);
          const { createEmployee } = await import(workerData.domain);
          const store = Store.open({ dataDir: workerData.dataDir });
          parentPort.once('message', () => {
            try {
              store.uow.run(tx => {
                const result = createEmployee(tx.employees.list(), { kind: 'human' }, {
                  name: workerData.name, title: '开发', role_id: 'coder', avatar: 'library:guan-yu'
                }, { clock: { now: () => new Date().toISOString() }, ids: tx.global_ids });
                if (!result.ok) throw new Error(result.error.message);
                persistEmployeeEffect(tx, result.value);
              });
              parentPort.postMessage('created');
            } catch (error) { parentPort.postMessage(error.message); }
            finally { store.close(); parentPort.close(); }
          });
          parentPort.postMessage('ready');
        })().catch(error => { throw error; });
      `,
        {
          eval: true,
          workerData: {
            dataDir,
            name,
            store: new URL("../dist/index.js", import.meta.url).href,
            domain: new URL("../../domain/dist/index.js", import.meta.url).href,
          },
        },
      );
      workers.push(worker);
      ready.push(
        new Promise<void>((resolve, reject) => {
          worker.once("message", () => resolve());
          worker.once("error", reject);
        }),
      );
      return new Promise<string>((resolve, reject) => {
        worker.on("message", (message: string) => {
          if (message !== "ready") resolve(message);
        });
        worker.once("error", reject);
      });
    });
    await Promise.all(ready);
    for (const worker of workers) worker.postMessage("start");
    const output = await Promise.all(results);
    expect(output.filter((message) => message === "created")).toHaveLength(1);
    expect(output.find((message) => message !== "created")).toContain(
      "人物已被员工",
    );
    const store = Store.open({ dataDir });
    try {
      expect(store.uow.read((tx) => tx.employees.list())).toHaveLength(1);
      expect(
        store.uow.read((tx) =>
          tx.global_events
            .listAfter(0)
            .filter((event) => event.type === "employee_created"),
        ),
      ).toHaveLength(1);
    } finally {
      store.close();
    }
  } finally {
    await Promise.all(workers.map((worker) => worker.terminate()));
    rmSync(dataDir, { recursive: true, force: true });
  }
});
