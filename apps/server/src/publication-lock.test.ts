import { expect, test } from "vitest";
import { withPublication } from "./publication-lock.js";

test("publication work for one project is serialized, other projects are not, and failures release the lock", async () => {
  const order: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const first = withPublication("p", async () => {
    order.push("p1-start");
    await gate;
    order.push("p1-end");
  });
  const second = withPublication("p", async () => {
    order.push("p2");
  });
  await withPublication("q", async () => {
    order.push("q");
  });
  expect(order).toEqual(["p1-start", "q"]);
  release();
  await Promise.all([first, second]);
  expect(order).toEqual(["p1-start", "q", "p1-end", "p2"]);
  await expect(
    withPublication("p", async () => {
      throw new Error("boom");
    }),
  ).rejects.toThrow("boom");
  expect(await withPublication("p", async () => "after")).toBe("after");
});
