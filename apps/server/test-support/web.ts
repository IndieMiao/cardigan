import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Store } from "@cardigan/store";
import {
  resolveWebConfig,
  type WebConfigOverrides,
  type WebEnv,
} from "../src/web/config.js";
import {
  type RunningWebServer,
  startWebServer,
  type WebServerOptions,
} from "../src/web/server.js";

/**
 * Test support for the Workbench listener.
 *
 * Every harness gets its own in-memory store and its own static directory, so
 * tests never share a port, a cookie or a build.
 */

export interface WebHarness {
  readonly store: Store;
  readonly server: RunningWebServer;
  readonly port: number;
  readonly staticDir: string;
  /** Where attachment blobs live; separate from the static build directory. */
  readonly dataDir: string;
  /** `Host` header value a browser would send. */
  readonly hostHeader: string;
  /** Log in with `password` and return the cookie header value. */
  login(password: string): Promise<string>;
  close(): Promise<void>;
}

export interface HarnessOptions {
  readonly executionDiagnostics?: WebServerOptions["executionDiagnostics"];
  readonly mergeGate?: WebServerOptions["mergeGate"];
  readonly contextUsage?: WebServerOptions["contextUsage"];
  readonly log?: (event: Readonly<Record<string, unknown>>) => void;
  readonly env?: WebEnv;
  readonly overrides?: WebConfigOverrides;
  readonly password?: string;
  readonly staticFiles?: Readonly<Record<string, string>>;
  readonly stream?: {
    readonly pollMs?: number;
    readonly heartbeatMs?: number;
  };
}

const DEFAULT_FILES: Readonly<Record<string, string>> = {
  "index.html":
    '<!doctype html><html><head><title>Cardigan</title></head><body><div id="root"></div><script type="module" src="/assets/app.js"></script></body></html>',
  "assets/app.js": "console.log('cardigan');",
  "assets/app.css": "body { color: #111; }",
};

export async function webHarness(
  options: HarnessOptions = {},
): Promise<WebHarness> {
  const staticDir = mkdtempSync(join(tmpdir(), "cardigan-web-"));
  const files = options.staticFiles ?? DEFAULT_FILES;
  for (const [path, content] of Object.entries(files)) {
    const file = join(staticDir, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
  }
  const dataDir = mkdtempSync(join(tmpdir(), "cardigan-web-data-"));
  const store = Store.open({ dbPath: ":memory:" });
  if (options.password !== undefined) {
    store.setWebPassword(options.password);
  }
  const server = await startWebServer({
    launchProfiles: () => ["fixture"],
    log: options.log ?? (() => undefined),
    store,
    dataDir,
    ...(options.mergeGate ? { mergeGate: options.mergeGate } : {}),
    ...(options.contextUsage ? { contextUsage: options.contextUsage } : {}),
    ...(options.executionDiagnostics
      ? { executionDiagnostics: options.executionDiagnostics }
      : {}),
    config: resolveWebConfig(options.env, {
      port: 0,
      staticDir,
      ...options.overrides,
    }),
    ...(options.stream === undefined ? {} : { stream: options.stream }),
  });
  return {
    store,
    server,
    port: server.port,
    staticDir,
    dataDir,
    hostHeader: `127.0.0.1:${server.port}`,
    login: async (password: string) => {
      const res = await call(port(server), "/api/login", {
        method: "POST",
        body: JSON.stringify({ password }),
        headers: {
          "content-type": "application/json",
          origin: `http://127.0.0.1:${server.port}`,
        },
      });
      if (res.status !== 200) {
        throw new Error(`login failed with ${res.status}`);
      }
      return String(res.headers["set-cookie"]).split(";")[0] ?? "";
    },
    close: async () => {
      await server.close();
      store.close();
      rmSync(staticDir, { recursive: true, force: true });
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

const port = (server: RunningWebServer): number => server.port;

export interface TestResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  readonly body: string;
  readonly json: unknown;
}

export interface CallOptions {
  readonly method?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string;
  /** Cookie header value, i.e. the session cookie to present. */
  readonly cookie?: string;
}

/** Plain HTTP call: `fetch` would not let a test set an arbitrary Host header. */
export function call(
  port: number,
  path: string,
  options: CallOptions = {},
): Promise<TestResponse> {
  const method = options.method ?? "GET";
  const headers: Record<string, string> = { ...options.headers };
  if (options.cookie !== undefined) {
    headers.cookie = options.cookie;
  }
  const body = options.body;
  if (body !== undefined) {
    headers["content-length"] = String(Buffer.byteLength(body));
  }
  return new Promise<TestResponse>((resolve, reject) => {
    const req = httpRequest(
      { host: "127.0.0.1", port, path, method, headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let json: unknown;
          try {
            json = JSON.parse(text);
          } catch {
            json = undefined;
          }
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: text,
            json,
          });
        });
      },
    );
    req.on("error", reject);
    req.end(body ?? undefined);
  });
}
