import { expect } from "vitest";

/**
 * Helpers for the M4 acceptance tests that wait on the host's background loops
 * (E02–E06, R01–R03).
 *
 * Merge, release/worktree-cleanup and reconcile run on timer loops, and every
 * round does real Git work; one scenario needs several rounds. These waits are
 * condition waits — they return as soon as the expected state is reached and
 * never sleep for a fixed duration — but the ceiling must tolerate a saturated
 * host (two full suites on one machine push a single round into the seconds),
 * otherwise a green scenario fails just because the machine was busy.
 *
 * A predicate passed here must be side-effect free and must not throw while the
 * condition is transiently false (use `refAt` for Git refs, whose absence is a
 * normal "not yet" answer).
 */
export const LIVE_LOOP_TIMEOUT_MS = 60_000;

/** A poll reloads a full project snapshot, so keep the interval coarse. */
export const POLL_INTERVAL_MS = 100;

/*
 * A test that waits on these loops should pass `120_000` as its own timeout:
 * the 60 s ceiling plus setup and teardown. The M4 acceptance files do that
 * explicitly instead of relying on the 5 s default, which a loaded host blows
 * through while still doing the real Git work.
 */

export const waitFor = <T>(read: () => T, timeout = LIVE_LOOP_TIMEOUT_MS) =>
  expect.poll(read, { timeout, interval: POLL_INTERVAL_MS });
