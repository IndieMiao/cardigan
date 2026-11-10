import { resolve } from "node:path";
import { AVATAR_LIBRARY, parseAvatarReference } from "@cardigan/domain";
import { fileAvatarStore, readAvatarFile } from "@cardigan/store";
import { CliError, EXIT } from "./errors.js";
import type { CliIo } from "./io.js";

export function runAvatarCommand(args: readonly string[], io: CliIo): number {
  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    io.stdout("用法：cardigan avatar list（列出内置头像的 id、名字和出处）");
    return EXIT.ok;
  }
  if (args.length !== 1 || args[0] !== "list")
    throw new CliError("用法：cardigan avatar list", EXIT.usage);
  io.stdout(
    AVATAR_LIBRARY.map(([id, name, novel]) => `${id}  ${name}  ${novel}`).join(
      "\n",
    ),
  );
  return EXIT.ok;
}

export function validateLibraryAvatar(value: string | undefined): void {
  if (value === undefined || value === "") return;
  if (parseAvatarReference(value)?.kind === "library") return;
  throw new CliError(
    value.startsWith("library:")
      ? `头像素材库中没有人物：${value.slice(8)}；请用 cardigan avatar list 查看`
      : "--avatar 请使用 library:<人物 id>；上传图片请用 --avatar-file <路径>",
    EXIT.usage,
  );
}

export async function uploadAvatarFile(
  path: string,
  dataDir: string,
  io: CliIo,
): Promise<string> {
  try {
    return await fileAvatarStore(dataDir).put(
      await readAvatarFile(resolve(io.cwd, path)),
    );
  } catch (error) {
    throw new CliError(
      `无法上传头像：${error instanceof Error ? error.message : "读取失败"}`,
      EXIT.usage,
    );
  }
}
