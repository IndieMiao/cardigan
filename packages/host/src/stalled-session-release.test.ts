import type { RuntimeObservation } from "@cardigan/domain";
import { expect, test } from "vitest";
import {
  DEFAULT_DONE_SESSION_RELEASE_MS,
  DEFAULT_STALLED_SESSION_RELEASE_MS,
  doneSessionReleaseMs,
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

test("C-759: the idle done-session threshold defaults to 10 minutes, 0 turns it off, invalid values fail", () => {
  expect(DEFAULT_DONE_SESSION_RELEASE_MS).toBe(600_000);
  expect(doneSessionReleaseMs({})).toBe(600_000);
  expect(doneSessionReleaseMs({ CARDIGAN_DONE_SESSION_RELEASE_MS: "" })).toBe(
    600_000,
  );
  expect(
    doneSessionReleaseMs({ CARDIGAN_DONE_SESSION_RELEASE_MS: "1800000" }),
  ).toBe(1_800_000);
  expect(doneSessionReleaseMs({ CARDIGAN_DONE_SESSION_RELEASE_MS: "0" })).toBe(
    0,
  );
  for (const bad of ["-1", "1.5", "10m", "3600001"])
    expect(() =>
      doneSessionReleaseMs({ CARDIGAN_DONE_SESSION_RELEASE_MS: bad }),
    ).toThrow("Invalid CARDIGAN_DONE_SESSION_RELEASE_MS");
});

test("C-759: an ended turn is released only on the CLI's own done", () => {
  const base = {
    trigger: "turn_done" as const,
    can_restart: false,
    status: live("done"),
    owner: "alive" as const,
    workspace: "clean" as const,
  };
  expect(stalledSessionDecision(base)).toEqual({
    action: "release",
    workspace: "clean",
    idle_basis: "terminal_status",
  });
  for (const agent of ["idle", "unknown", "working", "blocked"] as const)
    expect(stalledSessionDecision({ ...base, status: live(agent) })).toEqual({
      action: "skip",
      reason: `terminal_state=${agent}`,
    });
  expect(
    stalledSessionDecision({ ...base, status: live("done", { kept: true }) }),
  ).toEqual({ action: "skip", reason: "terminal_not_live" });
  expect(stalledSessionDecision({ ...base, workspace: "dirty" })).toEqual({
    action: "hand_off",
    reason: "workspace=dirty",
  });
});

test("C-838: an ended turn with no reported activity is released only on the bound empty editor", () => {
  const base = {
    trigger: "turn_done" as const,
    can_restart: false,
    status: live("unknown"),
    owner: "alive" as const,
    workspace: "clean" as const,
    idle_prompt: true,
  };
  expect(stalledSessionDecision(base)).toEqual({
    action: "release",
    workspace: "clean",
    idle_basis: "bound_idle_prompt",
  });
  // No editor seen (a turn, a draft, a confirmation, a failed read).
  expect(stalledSessionDecision({ ...base, idle_prompt: false })).toEqual({
    action: "skip",
    reason: "terminal_state=unknown",
  });
  // The editor never overrides a reported state, a kept shell or the owner.
  for (const agent of ["idle", "working", "blocked", "error"] as const)
    expect(stalledSessionDecision({ ...base, status: live(agent) })).toEqual({
      action: "skip",
      reason: `terminal_state=${agent}`,
    });
  expect(
    stalledSessionDecision({
      ...base,
      status: live("unknown", { kept: true }),
    }),
  ).toEqual({ action: "skip", reason: "terminal_not_live" });
  expect(stalledSessionDecision({ ...base, owner: "unobserved" })).toEqual({
    action: "skip",
    reason: "terminal_owner=unobserved",
  });
  // Work in the checkout still goes to PM.
  expect(stalledSessionDecision({ ...base, workspace: "dirty" })).toEqual({
    action: "hand_off",
    reason: "workspace=dirty",
  });
  // Other triggers keep their own rules.
  expect(
    stalledSessionDecision({
      ...base,
      trigger: "system_turn",
      owner: "unknown",
    }),
  ).toEqual({ action: "release", workspace: "clean" });
});
