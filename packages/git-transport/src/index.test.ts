import { expect, test } from "vitest";
import * as entry from "./index.js";

test("@cardigan/git-transport exposes local Git IO", () => {
  expect(Object.keys(entry)).toEqual(["LocalGitTransport"]);
});
