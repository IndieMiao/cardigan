// Isolated IPC lifecycle fixture; no normal-workload filler or host config.
import { CpuProfileController } from "../dist/cpu-profile-control.js";

const [dataDir] = process.argv.slice(2);
const controller = new CpuProfileController({
  dataDir,
  role: "background",
  sha: "d".repeat(40),
});
process.on("message", (message) => {
  if (message === "sync") {
    controller.sync();
    process.send("synced");
  }
});
process.once("SIGTERM", async () => {
  await controller.close();
  process.exit(0);
});
process.once("disconnect", () => process.exit(1));
process.send("ready");
