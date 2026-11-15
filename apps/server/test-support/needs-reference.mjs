// Read historical repository source only; no network or production state.
import { execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

export async function loadNeedsReference(
  root,
  revision = "200d82fb07e8f0cac9a26ad371e27bb3eff33772",
) {
  const compile = async (source, directory) => {
    const js = ts
      .transpileModule(source, {
        compilerOptions: {
          module: ts.ModuleKind.ESNext,
          target: ts.ScriptTarget.ES2024,
        },
      })
      .outputText.replace(/from "([^"]+)"/g, (_match, specifier) => {
        const url = specifier.startsWith(".")
          ? pathToFileURL(resolve(directory, specifier)).href
          : specifier.startsWith("node:")
            ? specifier
            : import.meta.resolve(specifier);
        return `from ${JSON.stringify(url)}`;
      });
    return import(
      `data:text/javascript;base64,${Buffer.from(js).toString("base64")}`
    );
  };
  const readerSource = execFileSync(
    "git",
    ["show", `${revision}:apps/server/src/web/needs-state.ts`],
    { cwd: root, encoding: "utf8" },
  );
  const reader = await compile(
    readerSource,
    join(root, "apps/server/dist/web"),
  );
  const source = execFileSync(
    "git",
    ["show", `${revision}:apps/server/src/web/read.ts`],
    { cwd: root, encoding: "utf8" },
  );
  const view = await compile(
    source,
    dirname(join(root, "apps/server/dist/web/read.js")),
  );
  return {
    readNeedsState: reader.readNeedsState,
    needsYou: view.needsYou,
  };
}
