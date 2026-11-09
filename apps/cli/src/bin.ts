#!/usr/bin/env node
import { installSqliteWarningFilter } from "@cardigan/host/warnings";

installSqliteWarningFilter();
const { main } = await import("./index.js");

const exitCode = await main(process.argv.slice(2));
process.exitCode = exitCode;
