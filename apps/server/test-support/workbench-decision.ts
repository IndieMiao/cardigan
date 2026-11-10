import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Store } from "@cardigan/store";
import { resolveWebConfig } from "../src/web/config.js";
import { startWebServer } from "../src/web/server.js";

/** Confirm through the authenticated human API, including its trusted channel marker. */
export async function confirmWorkbenchDecision(input: {
  store: Store;
  dataDir: string;
  project_id: string;
  decision_id: string;
  option: string;
}) {
  const password = "fixture workbench decision password";
  input.store.setWebPassword(password);
  const staticDir = join(input.dataDir, "decision-test-web");
  await mkdir(staticDir, { recursive: true });
  await writeFile(
    join(staticDir, "index.html"),
    "<!doctype html><title>Fixture</title>",
  );
  const web = await startWebServer({
    store: input.store,
    dataDir: input.dataDir,
    config: resolveWebConfig(
      {},
      { port: 0, staticDir, loginFailureDelayMs: 1 },
    ),
  });
  try {
    const login = await fetch(`${web.url}/api/login`, {
      method: "POST",
      headers: { origin: web.url, "content-type": "application/json" },
      body: JSON.stringify({ password }),
    });
    const cookie = login.headers.get("set-cookie")?.split(";")[0];
    await login.body?.cancel();
    if (login.status !== 200 || !cookie)
      throw new Error("Workbench fixture login failed");
    const response = await fetch(
      `${web.url}/api/projects/${encodeURIComponent(input.project_id)}/decisions/${encodeURIComponent(input.decision_id)}/resolve`,
      {
        method: "POST",
        headers: {
          cookie,
          origin: web.url,
          "content-type": "application/json",
          "idempotency-key": `cleanup-${input.decision_id}-${input.option}`,
        },
        body: JSON.stringify({
          option: input.option,
          raw_quote: `在 Workbench 确认 ${input.option}`,
        }),
      },
    );
    const result = await response.json();
    if (response.status !== 200)
      throw new Error(`Workbench decision failed: ${JSON.stringify(result)}`);
    return result;
  } finally {
    await web.close();
  }
}
