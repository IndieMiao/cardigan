/** Browser-port simulation over the real Web API; cookies are never exposed to app code. */
import { join } from "node:path";
import { URL as NodeURL } from "node:url";
import { vi } from "vitest";
import { type CardiganClient, HttpCardiganClient } from "../src/api.js";

export async function browserFixture(
  options: { emptyProjects?: boolean } = {},
) {
  // Keep Node's fileURLToPath compatible while running server/CLI code in jsdom.
  vi.stubGlobal("URL", NodeURL);
  const { m5Cross, TEST_PASSWORD } = await import(
    "../../server/test-support/m5-cross.js"
  );
  const f = await m5Cross();
  let url = f.web.url;
  let closeEmpty: (() => Promise<void>) | undefined;
  if (options.emptyProjects) {
    const { Store } = await import("../../../packages/store/dist/index.js");
    const { main, createProcessIo } = await import("../../cli/dist/index.js");
    const { startWebServer } = await import("../../server/src/web/server.js");
    const { resolveWebConfig } = await import("../../server/src/web/config.js");
    const dataDir = join(f.root, "empty-data"),
      store = Store.open({ dataDir });
    const code = await main(["web", "set-password"], {
      ...createProcessIo(),
      env: { CARDIGAN_DATA_DIR: dataDir },
      promptSecret: async () => TEST_PASSWORD,
      stdout: () => {},
      stderr: () => {},
    });
    if (code !== 0) throw new Error("Empty-store password setup failed");
    const web = await startWebServer({
      store,
      dataDir,
      config: resolveWebConfig({}, { port: 0, staticDir: f.staticDir }),
      log: () => {},
    });
    url = web.url;
    closeEmpty = async () => {
      await web.close();
      store.close();
    };
  } else if ((await f.password(TEST_PASSWORD)).code !== 0)
    throw new Error("Password setup failed");
  let cookie = "";
  const transport: typeof fetch = async (input, init) => {
    const headers = new Headers(init?.headers);
    if (init?.credentials === "same-origin" && cookie)
      headers.set("cookie", cookie);
    if (init?.method && init.method !== "GET") headers.set("origin", url);
    const response = await fetch(new NodeURL(String(input), url), {
      ...init,
      headers,
    });
    const setCookie = response.headers.get("set-cookie");
    if (setCookie) cookie = setCookie.split(";")[0] ?? "";
    return response;
  };
  const client = new HttpCardiganClient(transport);
  // M5.3 tests focus on rendering and commands; SSE protocol has its own real HTTP acceptance.
  client.subscribe = () => () => {};
  return {
    ...f,
    client,
    passwordText: TEST_PASSWORD,
    loginBrowser: () => client.login(TEST_PASSWORD),
    close: async () => {
      try {
        await closeEmpty?.();
      } finally {
        await f.close();
      }
    },
  };
}
export type BrowserFixture = Awaited<ReturnType<typeof browserFixture>>;

/** Decorate public client ports for pending requests, transport failures or untrusted legacy responses. */
export function decorate(
  client: CardiganClient,
  overrides: Partial<CardiganClient>,
): CardiganClient {
  return new Proxy(client, {
    get(target, property: keyof CardiganClient) {
      const method = overrides[property] ?? target[property];
      return typeof method === "function" ? method.bind(target) : method;
    },
  });
}
export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
