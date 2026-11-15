// Refuse before building or starting Vitest, even when hc is installed.
if (process.env.CARDIGAN_AGENT_LOCAL_TESTS === "1") {
  process.stderr.write("e2e 只在远程检查里跑\n");
  process.exit(1);
}
