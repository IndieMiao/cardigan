import { beforeEach, expect, test } from "vitest";
import type { Actor, Event } from "../entities.js";
import type { RunWaitRequest } from "../work-wait.js";
import { reportBlocker } from "./coordination.js";
import type { CommandEffect } from "./core.js";
import { prepareDelivery, submitDelivery, submitReview } from "./delivery.js";
import { type DeploymentRecord, recordDeployment } from "./deployment.js";
import { acknowledgeRun, dispatchRun, queueRun } from "./launch.js";
import { finishRun } from "./runtime.js";
import {
  actor,
  apply,
  fixture,
  human,
  id,
  ports,
  value,
} from "./test-fixtures.js";
import { resumeWorkWaits } from "./work-waits.js";

const system: Actor = { kind: "system", project_id: human.project_id };
const work = id("work_item", 1),
  owner = id("assignment", 1);
const base = "a".repeat(40),
  deployed = "b".repeat(40),
  later = "c".repeat(40);
let state = fixture(),
  io = ports(),
  currentRun = id("run", 1);
beforeEach(() => {
  state = fixture();
  io = ports();
  currentRun = id("run", 1);
});
function save<T>(effect: CommandEffect<T>) {
  state = apply(state, effect);
  return effect.data;
}
function finish(wait_for?: RunWaitRequest) {
  save(
    value(
      finishRun(
        state,
        actor(),
        {
          run_id: currentRun,
          outcome: "completed",
          summary: "Finished",
          ...(wait_for ? { wait_for } : {}),
        },
        io,
      ),
    ),
  );
}
function deploy(
  to: string,
  status: DeploymentRecord["status"] = "deployed",
  ready = status === "deployed",
  from = base,
) {
  const effect = value(
    recordDeployment(
      state,
      system,
      {
        attempt: `fixture-${to}-${status}`,
        from,
        to,
        status,
        ready,
        build: "passed",
        downtime_ms: 0,
        summary: status,
      },
      io,
    ),
  );
  save(effect);
  return effect.events[0];
}
function scan() {
  return value(resumeWorkWaits(state, system, {}, io));
}
function resume() {
  const result = scan();
  expect(result.data).toEqual([work]);
  save(result);
  const event = result.events.find(
    (e) => e.type === "work_item_resume_requested",
  );
  if (!event) throw new Error("Missing resume event");
  return event;
}
function start(trigger: Event) {
  const run = save(
    value(
      queueRun(
        state,
        system,
        {
          assignment_id: owner,
          kind: "followup",
          trigger_event_id: trigger.id,
          model: "fixture",
          agent_cli_version: "fixture",
        },
        io,
      ),
    ),
  );
  save(
    value(
      dispatchRun(
        state,
        system,
        {
          run_id: run.id,
          runtime_ref: {
            machine_id: "local",
            runtime_machine: "local",
            terminal_ref: "fixture-terminal",
            agent_name: "fixture",
          },
        },
        io,
      ),
    ),
  );
  save(value(acknowledgeRun(state, actor(), { run_id: run.id }, io)));
  currentRun = run.id;
}
async function deliveredThenReworked() {
  finish({ kind: "deployment_ready", target_id: deployed });
  deploy(deployed);
  start(resume());
  const params = {
    work_item_id: work,
    kind: "code" as const,
    summary: "Ready",
    subject: { kind: "git_head" as const, value: later },
    requested_verifiers: [id("work_item", 2)],
  };
  const receipt = value(
    await prepareDelivery(state, actor(), params, {
      verify: async () => ({ ok: true, value: [] }),
    }),
  );
  const effect = value(submitDelivery(state, actor(), params, receipt, io));
  const product = save(effect);
  expect(
    effect.events.find((e) => e.type === "delivery_submitted")?.payload,
  ).toEqual({ delivery_id: product.id, superseded: [] });
  finish();
  const review = value(
    submitReview(
      state,
      actor(2, "reviewer"),
      {
        delivery_id: product.id,
        target_sha: later,
        kind: "code",
        issues: [
          {
            severity: "major",
            description: "Fix required",
            impact: "functional" as const,
            must_fix: true,
            pre_existing: false,
          },
        ],
      },
      io,
    ),
  );
  save(review);
  expect(state.work_items.find((w) => w.id === work)?.status).toBe(
    "changes_requested",
  );
  const trigger = review.events.find((e) => e.type === "review_submitted");
  if (!trigger) throw new Error("Missing rework event");
  start(trigger);
}

for (const mode of ["blocker", "run"] as const) {
  test.each([false, true])(
    `${mode}: real delivery and review rework reset only a different wait (same=%s)`,
    async (same) => {
      await deliveredThenReworked();
      const condition = {
        kind: "deployment_ready" as const,
        target_id: same ? deployed : later,
      };
      if (mode === "blocker") {
        save(
          value(
            reportBlocker(
              state,
              actor(),
              {
                work_item_id: work,
                reason: "Waiting deployment",
                needs: "role",
                resume_when: condition,
              },
              io,
            ),
          ),
        );
        expect(
          state.work_items.find((w) => w.id === work)?.reported_blocker
            ?.auto_resume_disabled,
        ).toBe(same ? true : undefined);
        finish();
      } else {
        const result = finishRun(
          state,
          actor(),
          {
            run_id: currentRun,
            outcome: "completed",
            summary: "Wait deployment",
            wait_for: condition,
          },
          io,
        );
        expect(result.ok).toBe(!same);
        if (same) return;
        save(value(result));
      }
      deploy(condition.target_id);
      expect(scan().data).toEqual(same ? [] : [work]);
    },
  );

  test.each(["waiting_for_evidence", "waiting_for_capacity"] as const)(
    `${mode}: unrelated %s keeps target deployment evidence across a blocked scan`,
    (status) => {
      const condition = {
        kind: "deployment_ready" as const,
        target_id: deployed,
      };
      if (mode === "blocker")
        save(
          value(
            reportBlocker(
              state,
              actor(),
              {
                work_item_id: work,
                reason: "Waiting deployment",
                needs: "role",
                resume_when: condition,
              },
              io,
            ),
          ),
        );
      finish(mode === "run" ? condition : undefined);
      const ready = deploy(deployed);
      // Another gate can delay the first scan until the next deployment is waiting.
      state = {
        ...state,
        work_items: state.work_items.map((w) =>
          w.id === work ? { ...w, manual_assign: true } : w,
        ),
      };
      expect(scan().data).toEqual([]);
      deploy(later, status, false, deployed);
      state = {
        ...state,
        work_items: state.work_items.map((w) =>
          w.id === work ? { ...w, manual_assign: false } : w,
        ),
      };
      const restored = scan();
      expect(restored.data).toEqual([work]);
      expect(restored.events[0]?.payload).toMatchObject({
        evidence: ready?.id,
      });
      save(restored);
      expect(scan().events).toEqual([]);
    },
  );
}

test.each(["failed", "rolled_back"] as const)(
  "the target's later %s record does not authorize a wake",
  (status) => {
    finish({ kind: "deployment_ready", target_id: deployed });
    deploy(deployed);
    deploy(deployed, status, true);
    deploy(later, "waiting_for_capacity", false);
    expect(scan().data).toEqual([]);
  },
);
