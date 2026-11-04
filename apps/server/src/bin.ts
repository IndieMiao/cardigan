#!/usr/bin/env node
import { runServer } from "./index.js";

try {
  process.exitCode = await runServer();
} catch (error) {
  // Configuration and startup failures get a one-line message, not a stack.
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
}
