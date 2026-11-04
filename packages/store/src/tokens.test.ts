import { randomBytes } from "node:crypto";
import { expect, test } from "vitest";
import { hashToken, tokenMatchesHash } from "./index.js";
import { assignment, project_id, withTempStore } from "./test-support.js";

const fictionalToken = "fictional-token-not-a-real-credential";

test("issueToken stores only the sha256 hash", () => {
  withTempStore((store) => {
    const issued = store.issueToken({
      project_id,
      assignment_id: assignment().id,
      role: { role_version: 3, allowed_tools: ["whoami", "get_updates"] },
      token: fictionalToken,
      id: "tok_fictional",
    });

    expect(issued.record.id).toBe("tok_fictional");
    expect(issued.record.role_version).toBe(3);
    expect(issued.record.allowed_tools).toEqual(["whoami", "get_updates"]);

    const row = store.database
      .prepare("SELECT * FROM tokens WHERE id = ?")
      .get("tok_fictional");
    expect(row?.token_hash).toBe(hashToken(fictionalToken));
    // The plaintext token must not appear anywhere in the row.
    expect(JSON.stringify(row)).not.toContain(fictionalToken);
  });
});

test("generated tokens are long, random and only known by hash", () => {
  withTempStore((store) => {
    const first = store.issueToken({
      project_id,
      assignment_id: assignment().id,
      role: { role_version: 1, allowed_tools: ["whoami"] },
    });
    const second = store.issueToken({
      project_id,
      assignment_id: assignment().id,
      role: { role_version: 1, allowed_tools: ["whoami"] },
    });

    expect(first.token).not.toBe(second.token);
    expect(first.token.length).toBeGreaterThanOrEqual(32);
    expect(first.record.id).not.toBe(second.record.id);

    const stored = store.database
      .prepare("SELECT token_hash FROM tokens")
      .all()
      .map((row) => String(row.token_hash));
    expect(stored.sort()).toEqual(
      [hashToken(first.token), hashToken(second.token)].sort(),
    );
  });
});

test("verifyToken resolves the record, and revocation makes it invalid", () => {
  withTempStore((store) => {
    const issued = store.issueToken({
      project_id,
      assignment_id: assignment().id,
      role: { role_version: 2, allowed_tools: ["whoami"] },
      token: fictionalToken,
    });

    expect(store.verifyToken(fictionalToken)).toEqual(issued.record);
    expect(store.verifyToken("another-fictional-token")).toBeUndefined();

    expect(store.revokeToken(issued.record.id)).toBe(true);
    // Revoked behaves exactly like unknown: no distinction leaks to callers.
    expect(store.verifyToken(fictionalToken)).toBeUndefined();
    // Revoking twice keeps the first timestamp.
    expect(store.revokeToken(issued.record.id)).toBe(false);
  });
});

test("hashToken and tokenMatchesHash compare without leaking the token", () => {
  const hash = hashToken(fictionalToken);
  expect(hash).toMatch(/^[0-9a-f]{64}$/);
  expect(tokenMatchesHash(fictionalToken, hash)).toBe(true);
  expect(tokenMatchesHash(`${fictionalToken}x`, hash)).toBe(false);
  expect(tokenMatchesHash("", hash)).toBe(false);
});

test("different tokens never collide in the stored hash", () => {
  withTempStore((store) => {
    const tokens = new Set(
      Array.from({ length: 5 }, () => randomBytes(16).toString("hex")),
    );
    for (const token of tokens) {
      store.issueToken({
        project_id,
        assignment_id: assignment().id,
        role: { role_version: 1, allowed_tools: [] },
        token,
      });
    }

    for (const token of tokens) {
      expect(store.verifyToken(token)?.assignment_id).toBe(assignment().id);
    }
    // The unique index on token_hash means a repeated token is rejected.
    const [first] = [...tokens];
    expect(() =>
      store.issueToken({
        project_id,
        assignment_id: assignment().id,
        role: { role_version: 1, allowed_tools: [] },
        token: first,
      }),
    ).toThrow(/UNIQUE/i);
  });
});
