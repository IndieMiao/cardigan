import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { describe, expect, test } from "vitest";
import { call, webHarness } from "../../test-support/web.js";
import { acceptsGzip } from "./static.js";

const SCRIPT = `export const message = "${"cardigan ".repeat(200)}";\n`;
const STYLE = `body { color: #111; }\n${".card { margin: 0; }\n".repeat(100)}`;

async function precompressedHarness() {
  const harness = await webHarness({
    staticFiles: {
      "index.html": '<!doctype html><script src="/assets/app.js"></script>',
      "assets/app.js": SCRIPT,
      "assets/app.css": STYLE,
      "assets/plain.js": "console.log('no sibling');",
      "assets/font.woff2": "font fixture",
    },
  });
  const assets = join(harness.staticDir, "assets");
  mkdirSync(assets, { recursive: true });
  writeFileSync(join(assets, "app.js.gz"), gzipSync(SCRIPT));
  writeFileSync(join(assets, "app.css.gz"), gzipSync(STYLE));
  // A `.gz` next to a font is not ours to negotiate: fonts are served as is.
  writeFileSync(join(assets, "font.woff2.gz"), gzipSync("font fixture"));
  // A directory named like a sibling must not be mistaken for one.
  mkdirSync(join(assets, "plain.js.gz"));
  return harness;
}

describe("C-795 precompressed static assets", () => {
  test("a gzip client gets the .gz sibling with Content-Encoding and Vary", async () => {
    const harness = await precompressedHarness();
    try {
      for (const [path, text, type] of [
        ["/assets/app.js", SCRIPT, "text/javascript"],
        ["/assets/app.css", STYLE, "text/css"],
      ] as const) {
        const res = await call(harness.port, path, {
          headers: { "accept-encoding": "gzip, deflate, br, zstd" },
        });
        expect(res.status, path).toBe(200);
        expect(res.headers["content-encoding"], path).toBe("gzip");
        expect(res.headers.vary, path).toBe("Accept-Encoding");
        expect(String(res.headers["content-type"]), path).toContain(type);
        expect(res.headers["cache-control"], path).toContain("immutable");
        expect(Number(res.headers["content-length"]), path).toBe(
          res.bytes.byteLength,
        );
        expect(res.bytes.byteLength, path).toBeLessThan(
          Buffer.byteLength(text),
        );
        expect(gunzipSync(res.bytes).toString("utf8"), path).toBe(text);
      }
    } finally {
      await harness.close();
    }
  });

  test("a client without gzip gets the original bytes, still with Vary", async () => {
    const harness = await precompressedHarness();
    try {
      for (const headers of [
        {},
        { "accept-encoding": "identity" },
        { "accept-encoding": "br" },
        { "accept-encoding": "gzip;q=0, br" },
        { "accept-encoding": "*;q=0" },
      ]) {
        const label = JSON.stringify(headers);
        const res = await call(harness.port, "/assets/app.js", { headers });
        expect(res.status, label).toBe(200);
        expect(res.headers["content-encoding"], label).toBeUndefined();
        expect(res.headers.vary, label).toBe("Accept-Encoding");
        expect(res.headers["content-length"], label).toBe(
          String(Buffer.byteLength(SCRIPT)),
        );
        expect(res.body, label).toBe(SCRIPT);
      }
    } finally {
      await harness.close();
    }
  });

  test("HEAD reports the length of the representation GET would send", async () => {
    const harness = await precompressedHarness();
    try {
      const gzip = await call(harness.port, "/assets/app.js", {
        method: "HEAD",
        headers: { "accept-encoding": "gzip" },
      });
      expect(gzip.headers["content-encoding"]).toBe("gzip");
      expect(gzip.headers["content-length"]).toBe(
        String(gzipSync(SCRIPT).byteLength),
      );
      expect(gzip.body).toBe("");
      const plain = await call(harness.port, "/assets/app.js", {
        method: "HEAD",
      });
      expect(plain.headers["content-encoding"]).toBeUndefined();
      expect(plain.headers["content-length"]).toBe(
        String(Buffer.byteLength(SCRIPT)),
      );
    } finally {
      await harness.close();
    }
  });

  test("files without a usable sibling, fonts and the shell are sent as is", async () => {
    const harness = await precompressedHarness();
    try {
      const gzip = { "accept-encoding": "gzip" };
      const plain = await call(harness.port, "/assets/plain.js", {
        headers: gzip,
      });
      expect(plain.status).toBe(200);
      expect(plain.headers["content-encoding"]).toBeUndefined();
      expect(plain.headers.vary).toBe("Accept-Encoding");
      expect(plain.body).toBe("console.log('no sibling');");

      const font = await call(harness.port, "/assets/font.woff2", {
        headers: gzip,
      });
      expect(font.headers["content-encoding"]).toBeUndefined();
      expect(font.headers.vary).toBeUndefined();
      expect(font.body).toBe("font fixture");

      const shell = await call(harness.port, "/", { headers: gzip });
      expect(shell.headers["content-encoding"]).toBeUndefined();
      expect(shell.headers["cache-control"]).toBe("no-cache");
      expect(shell.body).toContain("/assets/app.js");
    } finally {
      await harness.close();
    }
  });
});

test("acceptsGzip follows Accept-Encoding weights", () => {
  expect(acceptsGzip(undefined)).toBe(false);
  expect(acceptsGzip("")).toBe(false);
  expect(acceptsGzip("gzip")).toBe(true);
  expect(acceptsGzip("GZIP")).toBe(true);
  expect(acceptsGzip("x-gzip")).toBe(true);
  expect(acceptsGzip("gzip, deflate, br, zstd")).toBe(true);
  expect(acceptsGzip("br;q=1.0, gzip;q=0.8, *;q=0.1")).toBe(true);
  expect(acceptsGzip("gzip;q=0")).toBe(false);
  expect(acceptsGzip("gzip; q=0.000")).toBe(false);
  expect(acceptsGzip("gzip;q=0, *")).toBe(false);
  expect(acceptsGzip("*")).toBe(true);
  expect(acceptsGzip("*;q=0")).toBe(false);
  expect(acceptsGzip("br, identity")).toBe(false);
  expect(acceptsGzip("gzipped")).toBe(false);
  expect(acceptsGzip("gzip;q=junk")).toBe(true);
  expect(acceptsGzip(["br", "gzip"])).toBe(true);
});
