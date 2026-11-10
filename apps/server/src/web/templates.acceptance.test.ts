import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type Actor,
  type Assignment,
  artifactCardTemplate,
  assign,
  type Card,
  type CommandEffect,
  type CommandPorts,
  type CommandState,
  createCard,
  type Delivery,
  dispatchRun,
  manageCardTemplate,
  queueRun,
  type Result,
  type Role,
  toolNames,
} from "@cardigan/domain";
import { prepareRoleWorktree } from "@cardigan/host";
import {
  loadCommandState,
  persistEffect,
  startMcpServer,
  unwrap,
} from "@cardigan/mcp-server";
import { routeEvent } from "@cardigan/router";
import { Store, writeRole } from "@cardigan/store";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { expect, test, vi } from "vitest";
import { ServerGit } from "../git.js";
import { cardDetail } from "./read.js";

test("a persisted legacy project with empty capabilities creates dev cards and assigns all three roles", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "cardigan-legacy-dev-"));
  const store = Store.open({ dataDir }),
    project = "legacy-dev";
  try {
    unwrap(store.createProject({ id: project }));
    store.uow.run((tx) => {
      for (const role_id of ["coder", "reviewer", "pm"])
        writeRole(
          tx,
          project,
          {
            role_id,
            version: 1,
            display_name: role_id,
            kind: role_id === "pm" ? "standing" : "work",
            harness: "codex",
            core_prompt: "Fixture",
            launch_profile_ref: "fixture",
            abilities: [],
            capabilities: [],
            required_machine_tags: [],
            worktree: role_id === "coder" ? "write" : "readonly",
            allowed_tools:
              role_id === "pm"
                ? ["whoami", "create_card", "assign"]
                : [
                    "whoami",
                    role_id === "coder" ? "submit_delivery" : "submit_review",
                  ],
          },
          { mode: "add" },
        );
      const human: Actor = { kind: "human", project_id: project };
      const ports = {
        clock: { now: () => new Date().toISOString() },
        ids: tx.ids,
      };
      const created = unwrap(
        createCard(
          loadCommandState(tx, project),
          human,
          {
            title: "Legacy dev",
            goal: "Preserve existing projects",
            acceptance_criteria: ["All roles can be assigned"],
            source: { kind: "quote", text: "Regression" },
            repo: "fixture/repo",
            base_branch: "main",
          },
          ports,
        ),
      );
      persistEffect(tx, project, created);
      expect(created.data).toMatchObject({
        template: "dev",
        template_version: 1,
      });
      for (const item of tx.work_items.list(project)) {
        const assigned = unwrap(
          assign(
            loadCommandState(tx, project),
            human,
            { work_item_id: item.id, role_id: item.role_id },
            ports,
          ),
        );
        persistEffect(tx, project, assigned);
      }
    });
    const state = store.uow.read((tx) => loadCommandState(tx, project));
    expect(state.roles).toHaveLength(3);
    expect(state.roles.every((r) => r.capabilities.length === 0)).toBe(true);
    expect(state.assignments.map((a) => a.role_id).sort()).toEqual([
      "coder",
      "pm",
      "reviewer",
    ]);
    for (const item of state.work_items)
      expect(state.assignments).toContainEqual(
        expect.objectContaining({
          id: item.assignment_id,
          work_item_id: item.id,
          role_id: item.role_id,
          status: "active",
        }),
      );
  } finally {
    store.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

/** Fake Agents talk to the actual MCP/SQLite/Git assembly; no hc or repository. */
test.each([
  { kind: "artifact_sha256", humanReview: false },
  { kind: "doc_version", humanReview: false },
  { kind: "doc_version", humanReview: true },
] as const)(
  "artifact $kind (human review: $humanReview) → completion review → done without a repository",
  async ({ kind, humanReview }) => {
    const dataDir = mkdtempSync(join(tmpdir(), "cardigan-artifact-"));
    const store = Store.open({ dataDir }),
      project = "artifact-fixture";
    const clients: Client[] = [];
    let server: Awaited<ReturnType<typeof startMcpServer>> | undefined;
    try {
      expect(store.createProject({ id: project }).ok).toBe(true);
      const clock = { now: () => new Date().toISOString() };
      const human: Actor = { kind: "human", project_id: project };
      function apply<T>(
        reduce: (
          s: CommandState,
          a: Actor,
          p: CommandPorts,
        ) => Result<CommandEffect<T>>,
      ): T {
        return store.uow.run((tx) => {
          const effect = unwrap(
            reduce(loadCommandState(tx, project), human, {
              clock,
              ids: tx.ids,
            }),
          );
          persistEffect(tx, project, effect);
          return effect.data;
        });
      }
      const role = (role_id: string, worktree: Role["worktree"]): Role => ({
        role_id,
        version: 1,
        display_name: role_id,
        kind: role_id === "pm" ? "standing" : "work",
        harness: "codex",
        core_prompt: "Fixture",
        launch_profile_ref: "fixture",
        abilities: [],
        capabilities: [],
        required_machine_tags: [],
        worktree,
        allowed_tools: [...toolNames],
      });
      store.uow.run((tx) => {
        writeRole(tx, project, role("designer", "none"), { mode: "add" });
        writeRole(tx, project, role("pm", "readonly"), { mode: "add" });
      });
      const office = store.uow.run((tx) => {
        const assignment: Assignment = {
          id: tx.ids.next(project, "assignment"),
          scope: "standing",
          role_id: "pm",
          role_version: 1,
          status: "active",
          runtime_state: "idle",
          runtime_ref: null,
          machine_id: "local",
          mcp_token_id: "fixture-office",
          created_at: clock.now(),
        };
        tx.assignments.put(project, assignment);
        return assignment;
      });
      const git = new ServerGit({ store, dataDir });
      const pin = vi.spyOn(git, "pinDelivery");
      server = await startMcpServer({
        store,
        dataDir,
        log: () => {},
        deliveryVerifier: git.verifierFor,
        pinDelivery: (request) => git.pinDelivery(request),
        port: 0,
      });
      const url = server.url;
      const connect = async (assignment: Assignment) => {
        const token = store.uow.run((tx) =>
          tx.issueToken({
            id: assignment.mcp_token_id,
            project_id: project,
            assignment_id: assignment.id,
            role: { role_version: 1, allowed_tools: [...toolNames] },
          }),
        );
        const client = new Client({
          name: `fake-${assignment.role_id}`,
          version: "1",
        });
        clients.push(client);
        await client.connect(
          new StreamableHTTPClientTransport(new URL(url), {
            requestInit: {
              headers: { Authorization: `Bearer ${token.token}` },
            },
          }),
        );
        return client;
      };
      let key = 0;
      async function call<T>(
        client: Client,
        name: string,
        args: object,
      ): Promise<T> {
        const response = await client.callTool({
          name,
          arguments: { ...args, idempotency_key: `fake-${++key}` },
        });
        expect(
          response.isError,
          JSON.stringify(response.structuredContent),
        ).not.toBe(true);
        return response.structuredContent as T;
      }
      const templateId = humanReview ? "human-artifact" : "artifact";
      if (humanReview)
        apply((s, a, p) =>
          manageCardTemplate(
            s,
            a,
            {
              action: "add",
              definition: {
                ...artifactCardTemplate,
                id: templateId,
                completion: { mode: "review", reviewer: "human" },
                work_items: [artifactCardTemplate.work_items[0]],
              },
            },
            p,
          ),
        );
      const planner = await connect(office);
      const card = await call<Card>(planner, "create_card", {
        template_id: templateId,
        title: "Design",
        goal: "Deliver approved document",
        acceptance_criteria: ["Document reviewed"],
        source: { kind: "quote", text: "Make document" },
      });
      const items = store.uow.read((tx) => tx.work_items.list(project));
      const production = items.find((w) => w.kind === "produce"),
        acceptance = items.find((w) => w.kind === "verify");
      if (!production || (!humanReview && !acceptance))
        throw new Error("Missing template work items");
      const start = async (item: NonNullable<typeof production>) => {
        const assignment = apply((s, a, p) =>
          assign(s, a, { work_item_id: item.id, role_id: item.role_id }, p),
        );
        const noRuntime = new Proxy(
          {},
          {
            get: () => {
              throw new Error(
                "No runtime or Git IO while preparing repository-free work",
              );
            },
          },
        ) as Parameters<typeof prepareRoleWorktree>[0]["runtime"];
        expect(
          await prepareRoleWorktree(
            {
              store,
              runtime: noRuntime,
              execution: { mode: "local", dataDir },
            },
            project,
            assignment.id,
          ),
        ).toBeUndefined();
        const run = apply((s, a, p) =>
          queueRun(
            s,
            a,
            {
              assignment_id: assignment.id,
              model: "fake",
              agent_cli_version: "fake-1",
            },
            p,
          ),
        );
        apply((s, a, p) =>
          dispatchRun(
            s,
            a,
            {
              run_id: run.id,
              runtime_ref: {
                machine_id: "local",
                runtime_machine: "fake",
                terminal_ref: assignment.id,
                agent_name: `fake-${assignment.id}`,
              },
            },
            p,
          ),
        );
        return connect(assignment);
      };
      const producer = await start(production);
      const entry = await call<{ id: string }>(producer, "post_comment", {
        card_id: card.id,
        body: "Document evidence",
      });
      const attachment = await call<{ id: string; sha256: string }>(
        producer,
        "upload_attachment",
        {
          card_id: card.id,
          kind: "evidence",
          mime: "text/plain",
          file: Buffer.from("Approved design").toString("base64"),
          attach_to: { kind: "timeline_entry", id: entry.id },
        },
      );
      const subject = {
        kind,
        value: kind === "artifact_sha256" ? attachment.sha256 : "design-v1",
      };
      const product = await call<Delivery>(producer, "submit_delivery", {
        work_item_id: production.id,
        kind: "design",
        summary: "Design ready",
        subject,
        attachments: [attachment.id],
        requested_verifiers: [],
      });
      expect(product.status).toBe("accepted");
      const requestCompletion = () =>
        call<Delivery>(producer, "submit_delivery", {
          work_item_id: production.id,
          kind: "card_completion",
          summary: "Document reviewed against acceptance criteria",
          subject,
          attachments: [attachment.id],
          requested_verifiers: acceptance ? [acceptance.id] : [],
        });
      const completion = await requestCompletion();
      if (humanReview) {
        const resolveReview = async (option: "approve" | "reject") => {
          const decision = store.uow.read((tx) =>
            tx.decisions.list(project).find((d) => d.status === "open"),
          );
          if (!decision) throw new Error("Missing human review decision");
          await call(planner, "record_decision", {
            decision_id: decision.id,
            option,
            raw_quote: option,
            rationale: "Checked document",
          });
        };
        await resolveReview("reject");
        const rejected = store.uow.read((tx) => loadCommandState(tx, project));
        const event = rejected.events.find(
          (e) => e.type === "completion_reviewed",
        );
        if (!event) throw new Error("Missing rejection event");
        const routed = routeEvent({ event, snapshot: rejected });
        expect(routed.notifications).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              kind: "review",
              recipient: expect.objectContaining({
                kind: "assignment",
                assignment_id: rejected.work_items.find(
                  (w) => w.id === production.id,
                )?.assignment_id,
              }),
            }),
          ]),
        );
        await requestCompletion();
        await resolveReview("approve");
      } else {
        if (!acceptance) throw new Error("Missing acceptance item");
        const reviewer = await start(acceptance);
        await call(reviewer, "submit_review", {
          delivery_id: completion.id,
          target_sha: subject.value,
          kind: "product",
          issues: [],
        });
      }
      const state = store.uow.read((tx) => loadCommandState(tx, project));
      expect(state.cards[0]).toMatchObject({
        template: templateId,
        template_version: 1,
        merge_policy: "none",
        status: "done",
        resolution: "done",
      });
      expect(state.cards[0]).not.toHaveProperty("repo");
      expect(
        state.assignments.every((a) => !a.worktree_path && !a.branch),
      ).toBe(true);
      expect(
        state.decisions.filter((d) => d.trigger !== "completion_review"),
      ).toEqual([]);
      expect(pin).not.toHaveBeenCalled();
      expect(cardDetail(state, card.id)).toBeDefined();
    } finally {
      for (const client of clients) await client.close();
      await server?.close();
      store.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  },
);
