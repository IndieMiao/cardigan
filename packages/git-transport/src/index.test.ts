import { expect, test } from "vitest";
import * as entry from "./index.js";

test("@cardigan/git-transport exposes local Git IO", () => {
  expect(entry.LocalGitTransport).toBeTypeOf("function");
  expect(entry.CentralGitTransport).toBeTypeOf("function");
});
