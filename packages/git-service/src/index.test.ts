import { expect, test } from "vitest";
import * as entry from "./index.js";

test("@cardigan/git-service exposes worktree orchestration", () => {
  expect(Object.keys(entry)).toEqual(["GitWorktreeService"]);
});
