import { randomBytes } from "node:crypto";
import {
  copyFile,
  cp,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer, request } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { Store } from "@cardigan/store";
import { resolveWebConfig } from "../dist/web/config.js";
import { startWebServer } from "../dist/web/server.js";

/** Screenshot-only entrypoint. Business writes are rejected before reaching Web. */
export async function startFixtureWeb({
  out,
  password,
  port = 0,
  staticDir,
} = {}) {
  if (typeof out !== "string" || typeof password !== "string")
    throw new Error("必须指定合成数据目录和预览密码");
  const manifest = JSON.parse(
    await readFile(join(out, "manifest.json"), "utf8"),
  );
  if (manifest.format !== "cardigan-synthetic-v1")
    throw new Error("只能预览生成器创建的合成数据");
  const dataDir = await mkdtemp(join(tmpdir(), "cardigan-synthetic-web-"));
  let store;
  let web;
  let proxy;
  const close = async () => {
    if (proxy?.listening) {
      const closed = new Promise((resolve, reject) =>
        proxy.close((error) => (error ? reject(error) : resolve())),
      );
      proxy.closeAllConnections();
      await closed;
    }
    await web?.close();
    store?.close();
    store = undefined;
    await rm(dataDir, { recursive: true, force: true });
  };
  try {
    await copyFile(join(out, "cardigan.db"), join(dataDir, "cardigan.db"));
    for (const name of ["attachments", "avatars"])
      await cp(join(out, name), join(dataDir, name), { recursive: true });
    store = Store.open({ dbPath: join(dataDir, "cardigan.db") });
    store.setWebPassword(password); // Only the disposable copy ever contains a password hash.
    web = await startWebServer({
      store,
      dataDir,
      clock: { now: () => manifest.now },
      queueWarningMinutes: 30,
      log: () => {},
      config: resolveWebConfig(
        {},
        { port: 0, ...(staticDir ? { staticDir } : {}) },
      ),
    });
    let publicUrl;
    proxy = createServer((req, res) => {
      const reject = (status, message) => {
        res.writeHead(status, {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": "no-store",
        });
        res.end(
          JSON.stringify({ error: { code: "fixture_read_only", message } }),
        );
      };
      let url;
      try {
        url = new URL(req.url, publicUrl);
      } catch {
        reject(400, "无效请求");
        return;
      }
      // Do not rewrite an untrusted Origin/Host into an authenticated local request.
      if (
        url.origin !== publicUrl ||
        req.headers.host !== new URL(publicUrl).host ||
        (req.headers.origin && req.headers.origin !== publicUrl)
      ) {
        reject(403, "仅允许当前本地预览入口");
        return;
      }
      if (
        !["GET", "HEAD"].includes(req.method) &&
        !(
          req.method === "POST" &&
          ["/api/login", "/api/logout"].includes(url.pathname)
        )
      ) {
        reject(405, "合成截图预览只允许读取");
        return;
      }
      const upstream = request(
        new URL(url.pathname + url.search, web.url),
        {
          method: req.method,
          headers: {
            ...req.headers,
            host: new URL(web.url).host,
            ...(req.headers.origin ? { origin: web.url } : {}),
          },
        },
        (response) => {
          res.writeHead(response.statusCode, response.headers);
          response.pipe(res);
        },
      );
      upstream.on("error", () => {
        if (!res.headersSent) reject(502, "预览服务暂不可用");
        else res.destroy();
      });
      res.on("close", () => upstream.destroy());
      req.pipe(upstream);
    });
    await new Promise((resolve, reject) => {
      proxy.once("error", reject);
      proxy.listen(port, "127.0.0.1", resolve);
    });
    publicUrl = `http://127.0.0.1:${proxy.address().port}`;
    return { url: publicUrl, manifest, close };
  } catch (error) {
    await close();
    throw error;
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  let preview;
  try {
    const { values } = parseArgs({
      args: process.argv.slice(2).filter((arg) => arg !== "--"),
      options: {
        out: { type: "string" },
        credentials: { type: "string" },
        port: { type: "string" },
      },
    });
    if (!values.credentials)
      throw new Error("必须指定新凭据文件 --credentials");
    const password = randomBytes(24).toString("base64url");
    preview = await startFixtureWeb({
      out: values.out,
      password,
      port: values.port === undefined ? 0 : Number(values.port),
    });
    await writeFile(values.credentials, `${password}\n`, {
      flag: "wx",
      mode: 0o600,
    });
    process.stdout.write(
      `${JSON.stringify({ url: preview.url, profile: preview.manifest.profile, seed: preview.manifest.seed, now: preview.manifest.now, read_only: true })}\n`,
    );
    for (const signal of ["SIGINT", "SIGTERM"])
      process.once(signal, () => {
        preview.close().then(
          () => process.exit(0),
          () => process.exit(1),
        );
      });
  } catch {
    await preview?.close();
    process.stderr.write(
      "合成预览启动失败：请核对数据目录、构建、端口和新凭据文件。\n",
    );
    process.exitCode = 1;
  }
}
