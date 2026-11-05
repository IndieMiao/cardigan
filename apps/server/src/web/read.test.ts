// biome-ignore-all lint/suspicious/noExplicitAny: the assertions read a few
// fields out of large JSON bodies; pinning every response type here would
// duplicate the API surface without testing anything extra.
/**
 * M5.1 read-only Workbench API (plan phase-1-m5 §4 M5.1; development plan §8.3,
 * §8.4, §8.5, §8.6).
 *
 * The endpoints answer from the domain queries (`projectSnapshot`,
 * `listNeedsYou`) as the human. The tests assert the data the plan promises:
 * two card filters that differ, a card page with everything it must show, the
 * Needs You ordering, the snapshot split between you and the Agents, and the
 * execution view's Assignment/Run/cursor rows.
 */
import { expect, test } from "vitest";
import { call, type WebHarness, webHarness } from "../../test-support/web.js";
import {
  NOW,
  project_id,
  seedWebProject,
} from "../../test-support/web-data.js";

const PASSWORD = "correct horse battery";

/** Loose but explicit shape: these tests read a few fields of a big body. */
type ReadBody = Record<string, any>;

async function seeded(): Promise<{
  harness: WebHarness;
  cookie: string;
  seeded: ReturnType<typeof seedWebProject>;
}> {
  const harness = await webHarness({ password: PASSWORD });
  const seeded = seedWebProject(harness.store, harness.dataDir);
  const cookie = await harness.login(PASSWORD);
  return { harness, cookie, seeded };
}

test("every read endpoint requires a session", async () => {
  const harness = await webHarness({ password: PASSWORD });
  try {
    seedWebProject(harness.store, harness.dataDir);
    for (const path of [
      "/api/projects",
      `/api/projects/${project_id}/cards`,
      `/api/projects/${project_id}/cards/C-1`,
      `/api/projects/${project_id}/needs-you`,
      `/api/projects/${project_id}/snapshot`,
      `/api/projects/${project_id}/execution`,
      `/api/projects/${project_id}/activity`,
      `/api/projects/${project_id}/stream`,
      `/api/projects/${project_id}/attachments/F-1`,
    ]) {
      const res = await call(harness.port, path);
      expect(res.status, path).toBe(401);
    }
  } finally {
    await harness.close();
  }
});

test("projects are listed and an unknown project is a 404", async () => {
  const { harness, cookie } = await seeded();
  try {
    const res = await call(harness.port, "/api/projects", { cookie });
    expect(res.status).toBe(200);
    expect(res.json).toEqual({
      projects: [
        {
          id: project_id,
          name: "Fixture project",
          created_at: expect.any(String),
        },
      ],
    });
    const missing = await call(harness.port, "/api/projects/p-missing/cards", {
      cookie,
    });
    expect(missing.status).toBe(404);
  } finally {
    await harness.close();
  }
});

test("the card list separates 'needs me' from 'waiting on an agent'", async () => {
  const { harness, cookie } = await seeded();
  try {
    const all = await call(harness.port, `/api/projects/${project_id}/cards`, {
      cookie,
    });
    expect(all.status).toBe(200);
    const body = all.json as {
      cards: {
        id: string;
        status: string;
        why: string;
        next_owners: unknown[];
      }[];
      counts: { total: number; needs_me: number; agent: number };
    };
    expect(body.cards.map((card) => card.id)).toEqual(["C-1", "C-2", "C-3"]);
    expect(body.counts.total).toBe(3);
    expect(body.counts.needs_me).toBe(1);
    expect(body.counts.agent).toBe(1);
    // Derived status comes from the domain, not from the stored field.
    expect(body.cards.find((card) => card.id === "C-3")?.status).toBe("done");

    const needsMe = await call(
      harness.port,
      `/api/projects/${project_id}/cards?filter=needs_me`,
      { cookie },
    );
    const needsMeBody = needsMe.json as {
      cards: { id: string; why: string }[];
    };
    expect(needsMeBody.cards.map((card) => card.id)).toEqual(["C-1"]);
    expect(needsMeBody.cards[0]?.why).toContain("等你拍板");

    const agent = await call(
      harness.port,
      `/api/projects/${project_id}/cards?filter=agent`,
      { cookie },
    );
    expect(
      (agent.json as { cards: { id: string }[] }).cards.map((c) => c.id),
    ).toEqual(["C-2"]);

    const bad = await call(
      harness.port,
      `/api/projects/${project_id}/cards?filter=whatever`,
      { cookie },
    );
    expect(bad.status).toBe(400);
  } finally {
    await harness.close();
  }
});

test("a card page carries work items, timeline, relations and attachments", async () => {
  const { harness, cookie } = await seeded();
  try {
    const res = await call(
      harness.port,
      `/api/projects/${project_id}/cards/C-1`,
      {
        cookie,
      },
    );
    expect(res.status).toBe(200);
    const body = res.json as ReadBody;
    expect(body.card.id).toBe("C-1");
    expect(body.card.goal).toContain("Goal of C-1");
    expect(body.work_items.map((item: { id: string }) => item.id)).toEqual([
      "W-1",
    ]);
    // Timeline is newest first; every entry belongs to this card.
    expect(
      body.timeline.map((entry: { event_seq: number }) => entry.event_seq),
    ).toEqual([2, 1]);
    expect(body.timeline[0].card_id).toBe("C-1");
    expect(body.counts.timeline).toBe(2);
    expect(
      body.decisions.map((decision: { id: string }) => decision.id),
    ).toEqual(["D-1"]);
    // §8.4 关联区: the blocking decision and the related card.
    expect(body.relations.decisions[0]).toMatchObject({
      id: "D-1",
      status: "open",
      blocking: true,
      decider: "human",
    });
    expect(body.relations.decisions[0].question.length).toBeLessThanOrEqual(40);
    // C-3 relates to C-1, so it shows in C-1's relations as well? No: only the
    // card that declares the relation lists it, and that is C-3.
    expect(body.relations.cards).toEqual([]);
    // Attachment metadata, with the decision status that the artifact rests on.
    const artifact = body.attachments.find(
      (attachment: { id: string }) => attachment.id === "F-2",
    );
    expect(artifact).toMatchObject({
      kind: "artifact",
      basis: { id: "D-1", status: "open" },
      inline: false,
      download_path: `/api/projects/${project_id}/attachments/F-2`,
    });
    const image = body.attachments.find(
      (attachment: { id: string }) => attachment.id === "F-1",
    );
    expect(image.inline).toBe(true);

    const missing = await call(
      harness.port,
      `/api/projects/${project_id}/cards/C-9`,
      { cookie },
    );
    expect(missing.status).toBe(404);
  } finally {
    await harness.close();
  }
});

test("Needs You explains each item and how long it has waited", async () => {
  const { harness, cookie } = await seeded();
  try {
    const res = await call(
      harness.port,
      `/api/projects/${project_id}/needs-you`,
      {
        cookie,
      },
    );
    expect(res.status).toBe(200);
    const body = res.json as ReadBody;
    expect(body.counts).toEqual({ decisions: 1, human_actions: 1 });
    expect(body.decisions[0]).toMatchObject({
      kind: "decision",
      id: "D-1",
      blocking: true,
      card_id: "C-1",
    });
    expect(body.decisions[0].why.length).toBeLessThanOrEqual(40);
    expect(body.decisions[0].options).toHaveLength(2);
    expect(body.decisions[0].opened_at).toBe(NOW);
    expect(typeof body.decisions[0].waited_ms).toBe("number");
    // A project-level human action has no card but still shows here.
    expect(body.human_actions[0]).toMatchObject({
      kind: "human_action",
      id: "H-1",
      card_id: null,
    });
    expect(body.human_actions[0].why.length).toBeLessThanOrEqual(40);
  } finally {
    await harness.close();
  }
});

test("the project snapshot groups cards and who acts next", async () => {
  const { harness, cookie } = await seeded();
  try {
    const res = await call(
      harness.port,
      `/api/projects/${project_id}/snapshot`,
      {
        cookie,
      },
    );
    expect(res.status).toBe(200);
    const body = res.json as ReadBody;
    expect(body.by_status).toMatchObject({ in_progress: 2, done: 1 });
    expect(
      body.in_progress.map((card: { id: string }) => card.id).sort(),
    ).toEqual(["C-1", "C-2"]);
    expect(body.waiting.human).toEqual(["C-1"]);
    expect(body.waiting.agent).toEqual(["C-2"]);
    expect(body.recent_deliveries).toEqual([]);
    expect(body.generated_at).toBeDefined();
  } finally {
    await harness.close();
  }
});

test("the execution view lists assignments, their run, worktree and cursor", async () => {
  const { harness, cookie } = await seeded();
  try {
    const res = await call(
      harness.port,
      `/api/projects/${project_id}/execution`,
      {
        cookie,
      },
    );
    expect(res.status).toBe(200);
    const body = res.json as ReadBody;
    const assignment = body.assignments[0];
    expect(assignment).toMatchObject({
      id: "A-1",
      role_id: "coder",
      status: "active",
      runtime_state: "running",
      worktree_path: "/srv/agent/worktrees/A-1",
      branch: "agent/C-2/W-2",
    });
    expect(assignment.run).toMatchObject({ id: "R-1", status: "running" });
    expect(assignment.cursors).toEqual([{ card_id: "C-2", acked_seq: 1 }]);
    expect(body.runs).toHaveLength(1);
    expect(body.machines).toEqual([]);
  } finally {
    await harness.close();
  }
});

test("项目动态 filters by card, role and type and pages backwards", async () => {
  const { harness, cookie } = await seeded();
  try {
    const base = `/api/projects/${project_id}/activity`;
    const all = await call(harness.port, base, { cookie });
    const allBody = all.json as Record<string, any>;
    // Newest first, and the project-level event is included.
    expect(allBody.events).toHaveLength(4);
    expect(
      allBody.events.some(
        (event: { card_id: string | null }) => event.card_id === null,
      ),
    ).toBe(true);
    expect(allBody.next_before).toBeNull();

    const byCard = await call(harness.port, `${base}?card_id=C-1`, { cookie });
    expect(
      (byCard.json as { events: { card_id: string }[] }).events.map(
        (event) => event.card_id,
      ),
    ).toEqual(["C-1", "C-1"]);

    const byRole = await call(harness.port, `${base}?role=pm`, { cookie });
    expect((byRole.json as { events: unknown[] }).events).toHaveLength(2);

    const byType = await call(harness.port, `${base}?type=comment_added`, {
      cookie,
    });
    expect((byType.json as { events: { type: string }[] }).events).toEqual([
      expect.objectContaining({ type: "comment_added", role: "human" }),
    ]);

    const page = await call(harness.port, `${base}?limit=2`, { cookie });
    const pageBody = page.json as Record<string, any>;
    expect(pageBody.events).toHaveLength(2);
    expect(pageBody.next_before).toBe(pageBody.events[1].id);

    const older = await call(
      harness.port,
      `${base}?limit=2&before=${pageBody.next_before}`,
      { cookie },
    );
    const olderIds = (older.json as { events: { id: string }[] }).events.map(
      (event) => event.id,
    );
    expect(olderIds).not.toContain(pageBody.events[0].id);
    expect(olderIds).toHaveLength(2);
  } finally {
    await harness.close();
  }
});

test("attachments download, and only bitmaps may render inline", async () => {
  const { harness, cookie } = await seeded();
  try {
    const html = await call(
      harness.port,
      `/api/projects/${project_id}/attachments/F-2`,
      { cookie },
    );
    expect(html.status).toBe(200);
    expect(html.body).toContain("alert(1)");
    expect(String(html.headers["content-type"])).toBe("text/html");
    expect(String(html.headers["content-disposition"])).toMatch(
      /^attachment; filename="F-2\.html"$/,
    );
    expect(html.headers["x-content-type-options"]).toBe("nosniff");
    expect(String(html.headers["content-security-policy"])).toContain(
      "sandbox",
    );

    const png = await call(
      harness.port,
      `/api/projects/${project_id}/attachments/F-1`,
      { cookie },
    );
    expect(png.status).toBe(200);
    expect(String(png.headers["content-disposition"])).toMatch(/^inline;/);
    expect(String(png.headers["content-type"])).toBe("image/png");

    const missing = await call(
      harness.port,
      `/api/projects/${project_id}/attachments/F-9`,
      { cookie },
    );
    expect(missing.status).toBe(404);
  } finally {
    await harness.close();
  }
});

test("reading the board does not move any Agent cursor", async () => {
  const { harness, cookie } = await seeded();
  try {
    const routes = [
      `/api/projects/${project_id}/cards`,
      `/api/projects/${project_id}/cards/C-1`,
      `/api/projects/${project_id}/needs-you`,
      `/api/projects/${project_id}/snapshot`,
      `/api/projects/${project_id}/execution`,
      `/api/projects/${project_id}/activity`,
    ];
    for (const path of routes) {
      expect((await call(harness.port, path, { cookie })).status).toBe(200);
    }
    const cursors = harness.store.uow.read((tx) => tx.cursors.list(project_id));
    expect(cursors).toEqual([
      { assignment_id: "A-1", card_id: "C-2", acked_seq: 1 },
    ]);
  } finally {
    await harness.close();
  }
});
