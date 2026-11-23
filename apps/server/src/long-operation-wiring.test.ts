import {
  fenceLongOperations,
  liveLongOperations,
  releaseLongOperationFence,
} from "@cardigan/host";
import { Store } from "@cardigan/store";
import { expect, test } from "vitest";
import { trackedPublisher } from "./server.js";

test("C-609: an artifact upload is registered for its whole duration, including failures", async () => {
  const store = Store.open({ dbPath: ":memory:" });
  try {
    store.createProject({ id: "sensen" });
    const seen: unknown[] = [];
    const publish = trackedPublisher(store, async (project, attachment) => {
      seen.push(liveLongOperations(store));
      if (attachment.card_id === "C-2") throw new Error("upload failed");
      return { url: `https://example.invalid/${project}`, size: 1, sha256: "" };
    });
    const call = (card: string) =>
      publish(
        "sensen" as never,
        { card_id: card } as never,
        {} as never,
        () => {},
        () => {},
      );
    await expect(call("C-1")).resolves.toMatchObject({ size: 1 });
    await expect(call("C-2")).rejects.toThrow("upload failed");
    expect(seen).toEqual([
      [
        expect.objectContaining({
          kind: "artifact_publication",
          project_id: "sensen",
          card_id: "C-1",
          label: "测试包外发",
        }),
      ],
      [expect.objectContaining({ card_id: "C-2" })],
    ]);
    expect(liveLongOperations(store)).toEqual([]);
  } finally {
    store.close();
  }
});

test("C-609: an upload requested while the stop fence stands starts only after it lifts", async () => {
  const store = Store.open({ dbPath: ":memory:" });
  try {
    store.createProject({ id: "sensen" });
    let started = false;
    const publish = trackedPublisher(store, async () => {
      started = true;
      return { url: "https://example.invalid/a", size: 1, sha256: "" };
    });
    fenceLongOperations(store);
    const pending = publish(
      "sensen" as never,
      { card_id: "C-1" } as never,
      {} as never,
      () => {},
      () => {},
    );
    await new Promise((r) => setTimeout(r, 50));
    expect(started).toBe(false);
    expect(liveLongOperations(store)).toEqual([]);
    releaseLongOperationFence(store);
    await expect(pending).resolves.toMatchObject({ size: 1 });
    expect(started).toBe(true);
  } finally {
    store.close();
  }
});
