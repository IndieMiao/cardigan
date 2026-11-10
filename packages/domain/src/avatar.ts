import { AVATAR_LIBRARY } from "./avatar-library.js";

export { AVATAR_LIBRARY } from "./avatar-library.js";

export type AvatarReference =
  | { readonly kind: "library"; readonly id: string }
  | { readonly kind: "upload"; readonly sha256: string };

/** Unknown/legacy references stay in storage but never become image URLs. */
export function parseAvatarReference(
  value: string | null | undefined,
): AvatarReference | null {
  if (value?.startsWith("library:")) {
    const id = value.slice(8);
    return AVATAR_LIBRARY.some(([known]) => known === id)
      ? { kind: "library", id }
      : null;
  }
  return value?.length === 71 && /^upload:[a-f0-9]{64}$/.test(value)
    ? { kind: "upload", sha256: value.slice(7) }
    : null;
}

export const MAX_AVATAR_BYTES = 2 * 1024 * 1024;

export interface AvatarImage {
  readonly bytes: Uint8Array;
  readonly mime: "image/png" | "image/webp" | "image/jpeg";
}

/** Global, content-addressed images, separate from card attachments. */
export interface AvatarStore {
  put(bytes: Uint8Array): Promise<string>;
  get(sha256: string): Promise<AvatarImage | undefined>;
}
