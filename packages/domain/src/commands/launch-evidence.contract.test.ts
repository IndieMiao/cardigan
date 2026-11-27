import { expect, test } from "vitest";
import type { RunId } from "../ids.js";
import {
  type LaunchEvidence,
  launchEvidenceRecorded,
  recordLaunchEvidence,
} from "./launch-evidence.js";
import { actor, apply, fixture, id, ports, value } from "./test-fixtures.js";

// C-806: modelled on sensen A-522 / R-4960: the card MCP never connected and
// the host reclaimed the session after the handshake deadline.
const system = { kind: "system" as const, project_id: fixture().project_id };
const evidence: LaunchEvidence = {
  reason: "mcp_unavailable",
  machine_id: "local",
  harness: "claude-code",
  waited_ms: 180_500,
  card_handshake: "pending",
  terminal: {
    state: "live",
    tail: ["Error: MCP server card: connection failed"],
    resources: {
      source: "scope",
      cpu_ms: 812,
      memory_bytes: 110_100_480,
      elapsed_ms: 182_000,
    },
  },
  mcp_servers: [
    {
      name: "card",
      status: "failed",
      error: "HTTP Connection failed after 3ms: ECONNREFUSED",
    },
    { name: "playwright", status: "connected", transport: "stdio" },
  ],
  unavailable: {},
};
const run = id("run", 1) as RunId;

test("records one bounded evidence event with a one-line timeline entry on the Run's card", () => {
  const state = fixture();
  const effect = value(
    recordLaunchEvidence(state, system, { run_id: run, evidence }, ports()),
  );
  expect(effect.data).toBe(true);
  expect(effect.changes).toEqual([]);
  expect(effect.events).toHaveLength(1);
  const [event] = effect.events;
  expect(event?.type).toBe("run_launch_evidence");
  expect(event?.card_id).toBe(id("card", 1));
  expect(event?.payload).toEqual({
    run_id: run,
    assignment_id: id("assignment", 1),
    ...evidence,
  });
  expect(effect.timeline).toHaveLength(1);
  expect(effect.timeline[0]?.type).toBe("system");
  expect(effect.timeline[0]?.body).toBe(
    `${run} 启动证据：回收原因 mcp_unavailable；终端仍在运行；MCP card 未连上、playwright 已连上；card 握手 pending；CPU 0.8 秒、内存 105 MB、已运行 182 秒。`,
  );
  // The screen tail stays in the event; the timeline only summarizes.
  expect(effect.timeline[0]?.body).not.toContain("Error:");

  const after = apply(state, effect);
  expect(launchEvidenceRecorded(after, run)).toBe(true);
  const again = value(
    recordLaunchEvidence(after, system, { run_id: run, evidence }, ports()),
  );
  expect(again.data).toBe(false);
  expect(again.events).toEqual([]);
});

test("an exited terminal and a missing part are named by bounded codes", () => {
  const effect = value(
    recordLaunchEvidence(
      fixture(),
      system,
      {
        run_id: run,
        evidence: {
          ...evidence,
          reason: "runtime_exited",
          terminal: {
            state: "finished",
            exit_code: 1,
            exit_reason: "exited",
            tail: [],
          },
          mcp_servers: null,
          card_handshake: null,
          unavailable: { mcp: "harness_unsupported" },
        },
      },
      ports(),
    ),
  );
  expect(effect.timeline[0]?.body).toBe(
    `${run} 启动证据：回收原因 runtime_exited；终端已结束，退出码 1（exited）；MCP 结果未取得（harness_unsupported）。`,
  );
});

test("only the system may record, and evidence beyond its limits is refused", () => {
  const state = fixture();
  expect(
    recordLaunchEvidence(state, actor(1), { run_id: run, evidence }, ports()),
  ).toMatchObject({ ok: false, error: { code: "unauthorized" } });
  expect(
    recordLaunchEvidence(
      state,
      system,
      { run_id: id("run", 99) as RunId, evidence },
      ports(),
    ),
  ).toMatchObject({ ok: false, error: { code: "not_found" } });
  const terminal = evidence.terminal as NonNullable<LaunchEvidence["terminal"]>;
  for (const bad of [
    { ...evidence, terminal: { ...terminal, tail: Array(21).fill("x") } },
    { ...evidence, terminal: { ...terminal, tail: ["x".repeat(201)] } },
    {
      ...evidence,
      terminal: { ...terminal, tail: Array(20).fill("é".repeat(60)) },
    },
    { ...evidence, terminal: { ...terminal, exit_code: 9999 } },
    {
      ...evidence,
      mcp_servers: [{ name: "../card", status: "failed" as const }],
    },
    {
      ...evidence,
      mcp_servers: [
        { name: "card", status: "failed" as const, error: "x".repeat(161) },
      ],
    },
    { ...evidence, unavailable: { mcp: "Free text with a /path" } },
  ])
    expect(
      recordLaunchEvidence(
        state,
        system,
        { run_id: run, evidence: bad as LaunchEvidence },
        ports(),
      ),
    ).toMatchObject({ ok: false, error: { code: "validation_failed" } });
});
