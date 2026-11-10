import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type AvatarStore, MAX_AVATAR_BYTES } from "@cardigan/domain";

const TYPES = {
  png: "image/png",
  webp: "image/webp",
  jpg: "image/jpeg",
} as const;
const hash = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");

/** Identify bitmap containers from their bytes, never their filename. */
function imageType(bytes: Buffer): keyof typeof TYPES | undefined {
  if (
    bytes.length >= 45 &&
    bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex")) &&
    bytes.readUInt32BE(8) === 13 &&
    bytes.toString("ascii", 12, 16) === "IHDR" &&
    bytes.readUInt32BE(16) > 0 &&
    bytes.readUInt32BE(20) > 0 &&
    bytes.subarray(-12).equals(Buffer.from("0000000049454e44ae426082", "hex"))
  )
    return "png";
  if (
    bytes.length >= 20 &&
    bytes.toString("ascii", 0, 4) === "RIFF" &&
    bytes.readUInt32LE(4) === bytes.length - 8 &&
    bytes.toString("ascii", 8, 12) === "WEBP" &&
    ["VP8 ", "VP8L", "VP8X"].includes(bytes.toString("ascii", 12, 16))
  )
    return "webp";
  if (
    bytes.length >= 4 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff &&
    bytes[bytes.length - 2] === 0xff &&
    bytes[bytes.length - 1] === 0xd9
  )
    return "jpg";
  return undefined;
}

/** Bounded reads also reject directories, FIFOs and symlinks in blob storage. */
export async function readAvatarFile(path: string): Promise<Buffer> {
  const file = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const info = await file.stat();
    if (!info.isFile()) throw new Error("头像必须是普通图片文件");
    if (info.size > MAX_AVATAR_BYTES) throw new Error("头像图片不能超过 2 MiB");
    const bytes = Buffer.alloc(MAX_AVATAR_BYTES + 1);
    let length = 0;
    while (length < bytes.length) {
      const read = await file.read(bytes, length, bytes.length - length, null);
      if (read.bytesRead === 0) break;
      length += read.bytesRead;
    }
    if (length > MAX_AVATAR_BYTES) throw new Error("头像图片不能超过 2 MiB");
    return bytes.subarray(0, length);
  } finally {
    await file.close();
  }
}

export function fileAvatarStore(dataDir: string): AvatarStore {
  const root = join(dataDir, "avatars");
  async function directory(create: boolean): Promise<boolean> {
    if (create) await mkdir(root, { recursive: true, mode: 0o700 });
    try {
      if (!(await lstat(root)).isDirectory())
        throw new Error("头像目录必须是普通目录");
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }
  return {
    async put(input) {
      const bytes = Buffer.from(input);
      if (bytes.length > MAX_AVATAR_BYTES)
        throw new Error("头像图片不能超过 2 MiB");
      const extension = imageType(bytes);
      if (!extension)
        throw new Error("头像只支持 PNG、WebP 或 JPEG 图片（按文件内容判断）");
      await directory(true);
      const sha256 = hash(bytes);
      const path = join(root, `${sha256}.${extension}`);
      try {
        await writeFile(path, bytes, { flag: "wx", mode: 0o600 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        if (hash(await readAvatarFile(path)) !== sha256)
          throw new Error("已有头像文件校验失败");
      }
      return `upload:${sha256}`;
    },
    async get(sha256) {
      if (
        sha256.length !== 64 ||
        !/^[a-f0-9]{64}$/.test(sha256) ||
        !(await directory(false))
      )
        return undefined;
      for (const extension of ["png", "webp", "jpg"] as const) {
        let bytes: Buffer;
        try {
          bytes = await readAvatarFile(join(root, `${sha256}.${extension}`));
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
          throw error;
        }
        if (hash(bytes) !== sha256 || imageType(bytes) !== extension)
          throw new Error("头像文件校验失败");
        return { bytes, mime: TYPES[extension] };
      }
      return undefined;
    },
  };
}
