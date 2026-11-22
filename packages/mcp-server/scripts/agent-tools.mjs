// Prebuilt agent tools: one file per tool that only imports Node built-ins, so
// any project's Agent can run them on a managed machine without installing
// packages. Bundled from the compiled package output (run `tsc -b` first).
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { rolldown } from "rolldown";

export const AGENT_TOOLS = ["download-attachment", "upload-evidence"];
const packageRoot = fileURLToPath(new URL("../", import.meta.url));
export const agentToolsDirectory = fileURLToPath(
  new URL("../../../deploy/agent-tools/", import.meta.url),
);

/** Returns `{ "<tool>.mjs": code }`; output is deterministic for the same input. */
export async function generateAgentTools() {
  const tools = {};
  for (const name of AGENT_TOOLS) {
    const bundle = await rolldown({
      input: join(packageRoot, "dist", `${name}.js`),
      platform: "node",
      logLevel: "silent",
    });
    try {
      const { output } = await bundle.generate({
        format: "esm",
        minify: true,
        banner: "#!/usr/bin/env node",
        codeSplitting: false,
      });
      if (output.length !== 1 || output[0].type !== "chunk")
        throw new Error(`Agent tool ${name} must be a single file`);
      tools[`${name}.mjs`] = output[0].code;
    } finally {
      await bundle.close();
    }
  }
  return tools;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await mkdir(agentToolsDirectory, { recursive: true });
  for (const [file, code] of Object.entries(await generateAgentTools())) {
    const path = join(agentToolsDirectory, file);
    await writeFile(path, code);
    await chmod(path, 0o755);
  }
}
