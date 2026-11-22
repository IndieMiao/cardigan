import { execFileSync } from "node:child_process";
import { test } from "vitest";
import { workerDirectoryCommand } from "./worker-directory-command.js";

test.each([true, false])(
  "directory command selects a verified binding on old and new installers (mac=%s)",
  (mac) => {
    execFileSync("/usr/bin/python3", [
      "-IB",
      new URL("../test-support/worker-directory-command.py", import.meta.url)
        .pathname,
      workerDirectoryCommand(mac, "second", "cg_second", "/fixture/second"),
    ]);
  },
);
