#!/usr/bin/env node
import { installSqliteWarningFilter } from "@cardigan/host/warnings";

installSqliteWarningFilter();
const { awaitLaunch } = await import("./launch-gate.js");
try {
  await awaitLaunch();
  const { runServer } = await import("./index.js");
  process.exitCode = await runServer({ role: "background" });
} catch (error) {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
}
