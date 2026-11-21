import { expect, test } from "vitest";
import { matchesBellReceipt, unreceivedBell } from "./bell-receipt.js";
import {
  actor,
  commit,
  dispatch,
  f,
  queue,
  ref,
  setup,
} from "./commands/launch/test-fixtures.js";
import { acknowledgeRun } from "./index.js";

test("business ACK is not a bell receipt; a completed or successor Run cannot inherit it", () => {
  setup();
  const queued = commit(queue());
  commit(dispatch(queued));
  const running = commit(
    acknowledgeRun(f.state, actor(), { run_id: queued.id }, f.io),
  );
  const card = f.state.cards[0]?.id;
  if (!card) throw new Error("missing card");
  const run = {
    ...running,
    bell_delivery: {
      run_id: running.id,
      card_id: card,
      runtime_ref: ref,
      sent_at: f.io.clock.now(),
    },
  };
  expect(unreceivedBell(run)).toBeDefined();
  const escalated = {
    ...run,
    bell_delivery: { ...run.bell_delivery, escalated_at: f.io.clock.now() },
  };
  expect(unreceivedBell(escalated)).toBeUndefined();
  expect(matchesBellReceipt(escalated, "heartbeat", { run_id: run.id })).toBe(
    true,
  );
  for (const tool of ["get_updates", "ack_events"]) {
    expect(matchesBellReceipt(run, tool, { card_id: card })).toBe(true);
    expect(matchesBellReceipt(run, tool, {})).toBe(false);
  }
  expect(matchesBellReceipt(run, "whoami", {})).toBe(false);
  expect(matchesBellReceipt(run, "heartbeat", { run_id: run.id })).toBe(true);
  expect(
    matchesBellReceipt(run, "heartbeat", { run_id: "R-999" as typeof run.id }),
  ).toBe(false);
  expect(
    unreceivedBell({ ...run, id: "R-999" as typeof run.id }),
  ).toBeUndefined();
  expect(unreceivedBell({ ...run, status: "completed" })).toBeUndefined();
  expect(
    unreceivedBell({
      ...run,
      bell_delivery: { ...run.bell_delivery, received_at: f.io.clock.now() },
    }),
  ).toBeUndefined();
});
