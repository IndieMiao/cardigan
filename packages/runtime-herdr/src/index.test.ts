import { expect, test } from "vitest";
import * as entry from "./index.js";

test("@cardigan/runtime-herdr exposes the Runtime adapter", () => {
  expect(entry.HerdrRuntime).toBeTypeOf("function");
});
