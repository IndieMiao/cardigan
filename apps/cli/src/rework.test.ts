import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withdrawReview } from "@cardigan/domain";
import { Store } from "@cardigan/store";
import { expect, test } from "vitest";
import { mergeFixture } from "../../../packages/domain/src/commands/merge/test-fixtures.js";
import { cliTool } from "./command-access.js";
import { main } from "./index.js";
import type { CliIo } from "./io.js";

const missing = (): never => {
  throw new Error("Missing fixture");
};

test("human CLI requests an exact rework then confirms it; missing evidence cannot return", async () => {
  const f = mergeFixture();
  const { product } = await f.accept();
  const review =
    f.state.reviews.find((r) => r.delivery_id === product.id) ?? missing();
  f.commit(
    withdrawReview(
      f.state,
      f.actor(f.reviewer),
      { work_item_id: review.work_item_id, rationale: "New requirement" },
      f.io,
    ),
  );
  const dataDir = mkdtempSync(join(tmpdir(), "cg-cli-rework-"));
  const store = Store.open({ dataDir });
  const project = f.state.project_id;
  const output: string[] = [],
    errors: string[] = [];
  const io: CliIo = {
    cwd: dataDir,
    platform: "linux",
    env: { CARDIGAN_CONFIG_DIR: dataDir },
    stdout: (line) => output.push(line),
    stderr: (line) => errors.push(line),
    signals: { on: () => undefined, off: () => undefined },
    spawnInherit: () => {
      throw new Error("No spawn");
    },
    captureCommand: async () => ({ code: 0, stdout: "", stderr: "" }),
  };
  try {
    store.createProject({ id: project });
    store.uow.run((tx) => {
      for (const v of f.state.cards) tx.cards.put(project, v);
      for (const v of f.state.work_items) tx.work_items.put(project, v);
      for (const v of f.state.assignments) tx.assignments.put(project, v);
      for (const v of f.state.runs) tx.runs.put(project, v);
      for (const v of f.state.deliveries) tx.deliveries.put(project, v);
      for (const v of f.state.reviews) tx.reviews.put(project, v);
      for (const v of f.state.decisions) tx.decisions.put(project, v);
      for (const v of f.state.roles) tx.roles.put(project, v);
      for (const v of f.state.events) tx.events.append(project, v);
      for (const stream of new Set(f.state.events.map((e) => e.card_id ?? "")))
        store.database
          .prepare(
            "INSERT INTO event_counters (project_id, stream, seq) VALUES (?, ?, ?)",
          )
          .run(
            project,
            stream,
            Math.max(
              ...f.state.events
                .filter((e) => (e.card_id ?? "") === stream)
                .map((e) => e.seq),
            ),
          );
    });
    const run = (...args: string[]) =>
      main(["rework", ...args, "--data-dir", dataDir], io);
    expect(
      await run("request", product.work_item_id, "--reason", "New requirement"),
    ).not.toBe(0);
    expect(
      store.uow.read((tx) => tx.deliveries.get(project, product.id))?.status,
    ).toBe("accepted");
    expect(
      await run(
        "request",
        product.work_item_id,
        "--delivery",
        product.id,
        "--sha",
        product.subject.value,
        "--review",
        review.id,
        "--reason",
        "New requirement",
      ),
    ).toBe(0);
    const q =
      store.uow.read((tx) =>
        tx.decisions
          .list(project)
          .find((q) => q.trigger === "accepted_delivery_rework"),
      ) ?? missing();
    expect(q.decider).toBe("human");
    expect(await run("confirm", q.id, "--reason", "Return exact target")).toBe(
      0,
    );
    expect(
      store.uow.read((tx) => tx.deliveries.get(project, product.id))?.status,
    ).toBe("superseded");
    expect(await run("confirm", q.id, "--reason", "Duplicate")).not.toBe(0);
    expect(output.join("\n")).toContain("已正式退回作者修改");
    expect(cliTool("rework request")).toBe("request_delivery_rework");
    expect(cliTool("rework confirm")).toBeNull();
  } finally {
    store.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});
