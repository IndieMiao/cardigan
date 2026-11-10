import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { AVATAR_LIBRARY } from "@cardigan/domain";
import { expect, test } from "vitest";

test("the original 59-character manifest matches the catalog and all 236 bundled images", async () => {
  const root = new URL("../../../apps/web/public/avatars/v1/", import.meta.url);
  type File = {
    path: string;
    sha256: string;
    bytes: number;
    width: number;
    height: number;
  };
  const manifest: {
    ownership: string;
    characters: {
      id: string;
      name: string;
      novel: string;
      files: { full: File; head: Record<string, File> };
    }[];
  } = JSON.parse(await readFile(new URL("manifest.json", root), "utf8"));
  expect(manifest.ownership).toBe("AI 生成、Cardigan 自有");
  expect(
    manifest.characters.map(({ id, name, novel }) => [id, name, novel]),
  ).toEqual(AVATAR_LIBRARY);
  expect(manifest.characters).toHaveLength(59);
  for (const character of manifest.characters) {
    expect(Object.keys(character.files.head).sort()).toEqual([
      "128",
      "256",
      "64",
    ]);
    for (const [size, file] of Object.entries(character.files.head)) {
      expect(file.path).toBe(`${character.id}/head-${size}.webp`);
      expect([file.width, file.height]).toEqual([Number(size), Number(size)]);
    }
    expect(character.files.full.path).toBe(`${character.id}/full.webp`);
    expect(character.files.full.width).toBe(768);
    for (const file of [
      character.files.full,
      ...Object.values(character.files.head),
    ]) {
      const bytes = await readFile(new URL(file.path, root));
      expect(bytes.length).toBe(file.bytes);
      expect(createHash("sha256").update(bytes).digest("hex"), file.path).toBe(
        file.sha256,
      );
    }
  }
  expect(await readFile(new URL("NOTICE.md", root), "utf8")).toContain(
    manifest.ownership,
  );
});
