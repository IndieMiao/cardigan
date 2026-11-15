import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Runtime } from "@cardigan/domain";
import { parseLaunchConfig } from "@cardigan/roles";
import { Store } from "@cardigan/store";
import { expect, test, vi } from "vitest";
import {
  assignment,
  fixture,
  ports,
  run,
} from "../../domain/src/commands/test-fixtures.js";
import {
  type ConnectionProbe,
  UpstreamHealthMonitor,
} from "./upstream-health.js";

test("V-1310: failed publication must not lose a completed unreachable sample and permit restart", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "cg-r2-publication-"));
  const writer = Store.open({ dataDir }),
    reader = Store.open({ dataDir });
  let now = "2026-01-01T00:10:00.000Z";
  const clock = { now: () => now };
  const config = parseLaunchConfig({
    providers: {
      relay: {
        harness: "codex",
        upstream: { group: "relay", probe_url: "https://fixture.invalid" },
      },
    },
    profiles: { agent: { harness: "codex", provider: "relay" } },
    upstream_health: {
      probe: { interval_ms: 1000, timeout_ms: 20, stale_after_ms: 60000 },
    },
  });
  const probe = vi
    .fn<ConnectionProbe>()
    .mockResolvedValueOnce({ status: "reachable" })
    .mockResolvedValueOnce({
      status: "unreachable",
      failure: "connection_error",
    })
    .mockResolvedValue({ status: "reachable" });
  const background = new UpstreamHealthMonitor(
    config,
    {} as Runtime,
    clock,
    probe,
    writer,
  );
  const web = new UpstreamHealthMonitor(
    config,
    {} as Runtime,
    clock,
    undefined,
    reader,
  );
  // The same completed failure in the former in-memory consumption path.
  const reference = new UpstreamHealthMonitor(
    config,
    {} as Runtime,
    clock,
    async () => ({ status: "unreachable", failure: "connection_error" }),
  );
  const allocator = ports();
  const state = {
    ...fixture(),
    assignments: [assignment(1)],
    runs: [{ ...run(1), launch_profile_ref: "agent" }],
    events: [
      {
        id: allocator.ids.nextEventId(),
        seq: 1,
        type: "run_inactive",
        actor: { kind: "system" as const, project_id: fixture().project_id },
        created_at: "2026-01-01T00:00:00.000Z",
        payload: {
          assignment_id: "A-1",
          run_id: "R-1",
          reason: "mcp_inactivity",
        },
      },
    ],
  };
  try {
    background.schedule();
    await vi.waitFor(() =>
      expect(web.diagnostics(state).providers[0]?.status).toBe("reachable"),
    );
    now = "2026-01-01T00:10:01.000Z";
    // Real SQLite write rejection, confined to this temporary synthetic database.
    writer.database.exec(
      "CREATE TEMP TRIGGER fail_probe_publication BEFORE INSERT ON upstream_probe_samples BEGIN SELECT RAISE(FAIL, 'synthetic sample publication failure'); END",
    );
    background.schedule();
    reference.schedule();
    await vi.waitFor(() =>
      expect(reference.diagnostics(state).providers[0]?.status).toBe(
        "unreachable",
      ),
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(probe).toHaveBeenCalledTimes(2);
    writer.database.exec("DROP TRIGGER fail_probe_publication");
    const view = (monitor: UpstreamHealthMonitor) => ({
      status: monitor.diagnostics(state).providers[0]?.status,
      last_failure_at:
        monitor.diagnostics(state).providers[0]?.last_failure_at ?? null,
      classification_available:
        monitor.diagnostics(state).classification_available,
      action: monitor.diagnosis(state, "A-1", undefined, { "A-1": "idle" })
        .action,
    });
    const proof = {
      completedProbe: "unreachable",
      reference: view(reference),
      background: view(background),
      web: view(web),
    };
    console.log("V1310_PUBLICATION_PROOF", JSON.stringify(proof));
    now = "2026-01-01T00:10:02.000Z";
    background.schedule();
    await vi.waitFor(() =>
      expect(web.diagnostics(state).providers[0]?.checked_at).toBe(now),
    );
    console.log("V1310_AFTER_NEXT_SUCCESS", JSON.stringify(view(web)));
    expect(proof.background.action).toBe("wait");
    expect(proof.background.status).toBe("unreachable");
    expect(proof.background.last_failure_at).toBe("2026-01-01T00:10:01.000Z");
    expect(proof.background.classification_available).toBe(false);
    expect(proof.web.classification_available).toBe(false);
    expect(view(web).last_failure_at).toBe("2026-01-01T00:10:01.000Z");
    expect(view(web).classification_available).toBe(true);
    expect(proof.web.action).toBe("wait");
  } finally {
    await background.close();
    await web.close();
    await reference.close();
    writer.close();
    reader.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});
