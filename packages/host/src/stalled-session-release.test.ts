import type { RuntimeObservation } from "@cardigan/domain";
import { expect, test } from "vitest";
import {
  DEFAULT_STALLED_SESSION_RELEASE_MS,
  managedReleaseCommand,
  stalledSessionDecision,
  stalledSessionReleaseMs,
} from "./stalled-session-release.js";

test("C-739: the stalled session release threshold defaults to 3 minutes, 0 turns it off, invalid values fail", () => {
  expect(DEFAULT_STALLED_SESSION_RELEASE_MS).toBe(180_000);
  expect(stalledSessionReleaseMs({})).toBe(180_000);
  expect(
    stalledSessionReleaseMs({ CARDIGAN_STALLED_SESSION_RELEASE_MS: "" }),
  ).toBe(180_000);
  expect(
    stalledSessionReleaseMs({ CARDIGAN_STALLED_SESSION_RELEASE_MS: "300000" }),
  ).toBe(300_000);
  expect(
    stalledSessionReleaseMs({ CARDIGAN_STALLED_SESSION_RELEASE_MS: "0" }),
  ).toBe(0);
  for (const bad of ["-1", "1.5", "3m", "3600001"])
    expect(() =>
      stalledSessionReleaseMs({ CARDIGAN_STALLED_SESSION_RELEASE_MS: bad }),
    ).toThrow("Invalid CARDIGAN_STALLED_SESSION_RELEASE_MS");
  expect(managedReleaseCommand("A-317" as never)).toBe(
    "cardigan assignment stop A-317",
  );
});

const live = (
  agent: RuntimeObservation["agent"],
  extra: Partial<RuntimeObservation> = {},
): RuntimeObservation => ({
  process: "alive",
  agent,
  observed_seq: 1,
  ...extra,
});

test("C-739: only a live, unconfirmed turn of this Assignment with a clean checkout is released", () => {
  const base = {
    can_restart: false,
    status: live("unknown"),
    owner: "unknown" as const,
    workspace: "clean" as const,
  };
  expect(stalledSessionDecision(base)).toEqual({
    action: "release",
    workspace: "clean",
  });
  // A confirmed owner the ordinary recovery cannot stop (a remote worker).
  expect(
    stalledSessionDecision({
      ...base,
      owner: "alive",
      status: live("idle"),
    }),
  ).toEqual({ action: "release", workspace: "clean" });
  expect(stalledSessionDecision({ ...base, workspace: "no_worktree" })).toEqual(
    { action: "release", workspace: "no_worktree" },
  );
  // Work in the checkout or an unreadable checkout goes to PM.
  for (const workspace of ["dirty", "unknown", "local_only"] as const)
    expect(stalledSessionDecision({ ...base, workspace })).toEqual({
      action: "hand_off",
      reason: `workspace=${workspace}`,
    });
  // Left to the existing paths: the ordinary owner-bound stop, an exit, a
  // kept shell, a CLI that reports work, a prompt or an error, an identity
  // that did not answer for this Assignment.
  const skipped: [Partial<typeof base> & Record<string, unknown>, string][] = [
    [{ can_restart: true }, "turn_recovery_available"],
    [{ status: undefined }, "terminal_not_live"],
    [
      { status: { ...live("unknown"), process: "exited" } },
      "terminal_not_live",
    ],
    [{ status: live("unknown", { kept: true }) }, "terminal_not_live"],
    [{ status: live("working") }, "terminal_state=working"],
    [{ status: live("blocked") }, "terminal_state=blocked"],
    [{ status: live("error") }, "terminal_state=error"],
    [{ owner: "unobserved" }, "terminal_owner=unobserved"],
    [{ owner: "exited" }, "terminal_owner=exited"],
  ];
  for (const [patch, reason] of skipped)
    expect(
      stalledSessionDecision({ ...base, ...patch } as typeof base),
    ).toEqual({ action: "skip", reason });
});
