#!/usr/bin/env node
import { runServer } from "./index.js";

process.exitCode = await runServer();
