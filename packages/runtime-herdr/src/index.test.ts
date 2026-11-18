import { expect, test } from "vitest";
import * as entry from "./index.js";

test("@cardigan/runtime-herdr exposes the Runtime adapter", () => {
  expect(entry.HerdrRuntime).toBeTypeOf("function");
});

test("local health does not accept an SSH runtime or weaken the SSH command boundary", async () => {
  expect(
    await entry.HerdrRuntime.prototype.checkLocalHealth.call({
      execution: { mode: "agent-ssh" },
    } as never),
  ).toMatchObject({ ok: false, error: { code: "invalid_launch" } });
  expect(
    await entry.HerdrRuntime.prototype.captureAgent.call(
      { execution: { mode: "local" } } as never,
      "git",
      ["--version"],
    ),
  ).toMatchObject({ ok: false, error: { code: "invalid_launch" } });
});
