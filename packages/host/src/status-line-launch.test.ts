import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "@cardigan/store";
import { expect, test } from "vitest";
import { statusLineContext } from "./launch.js";

test("C-686 status line context: card baseline ref and project thresholds", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "cg-status-line-"));
  const store = Store.open({ dataDir });
  try {
    store.createProject({ id: "p" });
    expect(statusLineContext(store, "p", "main")).toEqual({
      base_ref: "origin/main",
      handoff_remaining_pct: 20,
      restart_remaining_pct: 15,
    });
    store.uow.run((tx) =>
      tx.project_preferences.put("p", {
        id: "p",
        auto_merge_after_minutes: null,
        context_handoff_remaining_pct: 25,
        context_restart_remaining_pct: 20,
      }),
    );
    expect(statusLineContext(store, "p", undefined)).toEqual({
      handoff_remaining_pct: 25,
      restart_remaining_pct: 20,
    });
  } finally {
    store.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});
