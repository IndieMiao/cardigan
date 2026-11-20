// A real CLI process with synthetic probes. Hold SSH until the parent releases
// stdin; no SSH process or network connection is made by this fixture.
import { once } from "node:events";
import { createProcessIo } from "../dist/index.js";
import { runWorkerCommand } from "../dist/worker-wizard.js";

try {
  process.exitCode = await runWorkerCommand(
    ["check", ...process.argv.slice(2)],
    createProcessIo(),
    async (step) => {
      if (step === "ssh") await once(process.stdin, "data");
      return true;
    },
  );
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
