/** M5.T1: public CLI/domain/MCP setup; no direct repository or SQL writes. */
import { mkdir, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { join } from "node:path";
import { createProcessIo, main } from "@cardigan/cli";
import type { Attachment, TimelineEntry } from "@cardigan/domain";
import { Store } from "@cardigan/store";
import { resolveWebConfig } from "../src/web/config.js";
import { LoginLimiter } from "../src/web/login-limiter.js";
import { startWebServer, type WebServerOptions } from "../src/web/server.js";
import { m4Cross } from "./m4-cross.js";
export const TEST_PASSWORD = "acceptance password phrase";
export interface ResponseBody {
  readonly status: number;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  readonly text: string;
  readonly json: unknown;
}
export async function m5Cross(
  options: Pick<
    WebServerOptions,
    | "runLimit"
    | "runLimitMaximum"
    | "machineDisplayName"
    | "machineHost"
    | "resourceLimits"
    | "roleLaunchConfig"
  > = {},
) {
  const f = await m4Cross();
  let now = Date.now(),
    cookie = "";
  const clock = { now: () => new Date(now).toISOString() };
  const store = Store.open({ dataDir: f.dataDir, clock });
  const logs: unknown[] = [];
  const staticDir = join(f.root, "web-assets");
  await mkdir(staticDir);
  await writeFile(
    join(staticDir, "index.html"),
    "<!doctype html><title>Acceptance shell</title>",
  );
  const limiter = new (class extends LoginLimiter {
    override retryAfterSeconds(key: string) {
      return super.retryAfterSeconds(key, now);
    }
    override recordFailure(key: string) {
      return super.recordFailure(key, now);
    }
  })();
  const web = await startWebServer({
    launchProfiles: () => ["fixture", "codex-agent"],
    ...options,
    store,
    dataDir: f.dataDir,
    clock,
    loginLimiter: limiter,
    config: resolveWebConfig(
      {},
      { port: 0, staticDir, loginFailureDelayMs: 1 },
    ),
    log: (event) => logs.push(event),
    stream: { pollMs: 15, heartbeatMs: 30 },
  });
  const call = (
    path: string,
    options: {
      method?: string;
      body?: unknown;
      headers?: Record<string, string>;
      anonymous?: boolean;
    } = {},
  ) =>
    new Promise<ResponseBody>((resolve, reject) => {
      const data =
        options.body === undefined ? undefined : JSON.stringify(options.body);
      const request = httpRequest(
        web.url + path,
        {
          method: options.method ?? "GET",
          headers: {
            ...(!options.anonymous && cookie ? { cookie } : {}),
            ...(data
              ? {
                  "content-type": "application/json",
                  origin: web.url,
                  "content-length": String(Buffer.byteLength(data)),
                }
              : {}),
            ...options.headers,
          },
        },
        (response) => {
          const chunks: Buffer[] = [];
          response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
          response.on("end", () => {
            const text = Buffer.concat(chunks).toString();
            let json: unknown;
            try {
              json = JSON.parse(text);
            } catch {
              json = undefined;
            }
            resolve({
              status: response.statusCode ?? 0,
              headers: response.headers,
              text,
              json,
            });
          });
        },
      );
      request.on("error", reject);
      request.end(data);
    });
  const projectPath = (suffix: string) =>
    `/api/projects/${encodeURIComponent(f.project.project_id)}${suffix}`;
  async function password(value: string) {
    let error = "";
    const output: string[] = [];
    const code = await main(["web", "set-password"], {
      ...createProcessIo(),
      cwd: f.root,
      env: { CARDIGAN_DATA_DIR: f.dataDir },
      promptSecret: async () => value,
      stdout: (s) => output.push(s),
      stderr: (s) => {
        error += s;
      },
    });
    return { code, error, output: output.join("\n") };
  }
  async function login(value = TEST_PASSWORD) {
    const response = await call("/api/login", {
      method: "POST",
      body: { password: value },
      anonymous: true,
    });
    if (response.status === 200)
      cookie = String(response.headers["set-cookie"]).split(";")[0] ?? "";
    return response;
  }
  async function agentComment(body: string) {
    await f.start(f.primary.owner);
    return f.call<TimelineEntry>(f.primary.owner, "post_comment", {
      card_id: f.card.id,
      body,
    });
  }
  async function attachment(mime: string, body: string) {
    const target = await agentComment("Attachment evidence");
    return f.call<Attachment>(f.primary.owner, "upload_attachment", {
      card_id: f.card.id,
      file: Buffer.from(body).toString("base64"),
      mime,
      kind: "evidence",
      attach_to: { kind: "timeline_entry", id: target.id },
    });
  }
  return {
    ...f,
    store: () => store,
    web,
    staticDir,
    call,
    mcp: f.call,
    projectPath,
    password,
    login,
    agentComment,
    attachment,
    logs,
    cookie: () => cookie,
    setTime: (at: number) => {
      now = at;
    },
    advance: (ms: number) => {
      now += ms;
    },
    now: () => now,
    close: async () => {
      try {
        await web.close();
        store.close();
      } finally {
        await f.close();
      }
    },
  };
}
export type M5Cross = Awaited<ReturnType<typeof m5Cross>>;
