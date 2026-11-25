import { expect, test } from "vitest";
import {
  DEFAULT_RETENTION,
  parseRetention,
} from "./deployment-retention-policy.js";

test("C-743: retention is automatic by default: 10 releases, 7 days of backups, at least 3", () => {
  expect(parseRetention({})).toEqual({
    release_keep: 10,
    backup_days: 7,
    backup_min: 3,
    mode: "auto",
  });
  expect(
    parseRetention({
      release_keep: 4,
      backup_days: 2,
      backup_min: 1,
      mode: "preview",
    }),
  ).toEqual({
    release_keep: 4,
    backup_days: 2,
    backup_min: 1,
    mode: "preview",
  });
});

test("C-743: a host file written for the C-520 manifest still parses, with the new defaults", () => {
  expect(
    parseRetention({
      revision: 2,
      releases: 5,
      snapshots: 5,
      daily_days: 7,
      released_days: 3,
      approval: {
        sha256: "a".repeat(64),
        pm_review: "Q-1",
        data_deletion: "Q-2",
      },
    }),
  ).toEqual(DEFAULT_RETENTION);
});

test("C-743: invalid retention settings are rejected", () => {
  for (const policy of [
    { release_keep: 0 },
    { backup_days: "7" },
    { backup_min: 1.5 },
    { mode: "delete" },
    { path: "/tmp" },
    null,
    [],
  ])
    expect(() => parseRetention(policy)).toThrow();
});
