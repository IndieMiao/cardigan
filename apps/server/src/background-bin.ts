#!/usr/bin/env node
import { installSqliteWarningFilter } from "@cardigan/host/warnings";

installSqliteWarningFilter();
const { awaitLaunch } = await import("./launch-gate.js");
try {
  await awaitLaunch();
  const { runServer } = await import("./index.js");
  const { startWithBusyRetry, startupBusyRetryConfig } = await import(
    "./startup-busy-retry.js"
  );
  // C-650: a write lock left over from the switch delays the start; it does
  // not end it. Shutdown handlers exist only after a successful start.
  process.exitCode = await startWithBusyRetry(
    () => runServer({ role: "background" }),
    {
      ...startupBusyRetryConfig(process.env),
      warn: (line) => process.stderr.write(`${line}\n`),
    },
  );
} catch (error) {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
}
