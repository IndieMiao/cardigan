import { expect, test } from "vitest";
import * as entry from "./index.js";

test("@cardigan/store exposes an empty skeleton", () => {
  expect(Object.keys(entry)).toEqual([]);
});
