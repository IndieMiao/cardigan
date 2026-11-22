import { expect, test } from "vitest";
import { AVATAR_LIBRARY, parseAvatarReference } from "./avatar.js";

test("the library has unique identities and every reference resolves exactly", () => {
  expect(AVATAR_LIBRARY).toHaveLength(69);
  expect(new Set(AVATAR_LIBRARY.map(([id]) => id)).size).toBe(
    AVATAR_LIBRARY.length,
  );
  for (const [id] of AVATAR_LIBRARY) {
    expect(id).toMatch(/^[a-z0-9-]+$/);
    expect(parseAvatarReference(`library:${id}`)).toEqual({
      kind: "library",
      id,
    });
  }
  expect(parseAvatarReference("library:zhang-liang")).toEqual({
    kind: "library",
    id: "zhang-liang",
  });
  expect(parseAvatarReference(`upload:${"a".repeat(64)}`)).toEqual({
    kind: "upload",
    sha256: "a".repeat(64),
  });
});

test.each([
  null,
  undefined,
  "",
  "library:unknown",
  "library:../guan-yu",
  "library:guan-yu\n",
  "upload:../../secrets",
  `upload:${"a".repeat(63)}`,
  `upload:${"A".repeat(64)}`,
  `upload:${"a".repeat(64)}.png`,
  `upload:${"a".repeat(64)}\n`,
  "https://example.com/a.png",
  "/avatars/old.png",
  "avatar:one",
])("unknown reference %j never becomes an image identity", (ref) => {
  expect(parseAvatarReference(ref)).toBeNull();
});
