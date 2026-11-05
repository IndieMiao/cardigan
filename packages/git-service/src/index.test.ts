import { expect, test } from "vitest";
import * as entry from "./index.js";

test("@cardigan/git-service exposes worktree orchestration", () => {
  expect(entry.GitWorktreeService).toBeTypeOf("function");
  expect(entry.CentralRepositoryService).toBeTypeOf("function");
});
