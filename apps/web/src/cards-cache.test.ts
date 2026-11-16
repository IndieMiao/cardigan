import { expect, test, vi } from "vitest";
import { type CardPage, HttpCardiganClient } from "./api.js";
import { card } from "./testing/fixtures.js";

const page: CardPage = {
  project_id: "p-1",
  filter: "all",
  cards: [card],
  counts: { total: 1, needs_me: 0, agent: 1 },
  snapshot_version: "one",
};
const reply = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });

test("card reads carry versions, reconstruct deltas in server order and isolate queries/projects", async () => {
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValueOnce(reply(page))
    .mockResolvedValueOnce(
      reply({
        ...page,
        snapshot_version: "two",
        delta: true,
        card_ids: ["C-2", card.id],
        cards: [{ ...card, id: "C-2", title: "New" }],
      }),
    )
    .mockResolvedValueOnce(
      reply({
        ...page,
        snapshot_version: "three",
        delta: true,
        card_ids: ["C-2"],
        cards: [],
      }),
    )
    .mockResolvedValue(reply({ ...page, project_id: "other" }));
  const client = new HttpCardiganClient(fetch);
  await client.cards("p-1", "all", { mode: "list" });
  const second = await client.cards("p-1", "all", { mode: "list" });
  expect(String(fetch.mock.calls[1]?.[0])).toContain("since_version=one");
  expect(second.cards.map((c) => c.id)).toEqual(["C-2", card.id]);
  expect(
    (await client.cards("p-1", "all", { mode: "list" })).cards.map((c) => c.id),
  ).toEqual(["C-2"]);
  expect(client.cachedCards("p-1", "all", { mode: "board" })).toBeUndefined();
  expect(client.cachedCards("other", "all", { mode: "list" })).toBeUndefined();
  await client.cards("other", "all", { mode: "list" });
  expect(String(fetch.mock.calls.at(-1)?.[0])).not.toContain("since_version");
});

test.each([401, 403])(
  "authentication failure %s discards cached card bodies",
  async (status) => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(reply(page))
      .mockResolvedValue(reply({}, status));
    const client = new HttpCardiganClient(fetch);
    await client.cards("p-1", "all");
    await expect(client.cards("p-1", "all")).rejects.toMatchObject({ status });
    expect(client.cachedCards("p-1", "all", {})).toBeUndefined();
  },
);

test("a late request cannot replace a newer cached card snapshot", async () => {
  let resolve: (r: Response) => void = () => {};
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockImplementationOnce(
      () =>
        new Promise<Response>((r) => {
          resolve = r;
        }),
    )
    .mockResolvedValueOnce(reply({ ...page, snapshot_version: "new" }));
  const client = new HttpCardiganClient(fetch);
  const old = client.cards("p-1", "all");
  await client.cards("p-1", "all");
  resolve(reply(page));
  await old;
  expect(client.cachedCards("p-1", "all", {})?.snapshot_version).toBe("new");
});

test("logout and a different validated login discard snapshots and late replies", async () => {
  let resolve: (r: Response) => void = () => {};
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValueOnce(
      reply({
        authenticated: true,
        password_configured: true,
        read_scope: "first",
      }),
    )
    .mockResolvedValueOnce(reply(page))
    .mockImplementationOnce(
      () =>
        new Promise<Response>((r) => {
          resolve = r;
        }),
    )
    .mockResolvedValueOnce(reply({ ok: true }))
    .mockResolvedValueOnce(reply(page))
    .mockImplementation(async () =>
      reply({
        authenticated: true,
        password_configured: true,
        read_scope: "second",
      }),
    );
  const client = new HttpCardiganClient(fetch);
  await client.session();
  await client.cards("p-1", "all");
  const late = client.cards("p-1", "all");
  await client.logout();
  resolve(reply(page));
  await expect(late).rejects.toMatchObject({ status: 401 });
  expect(client.cachedCards("p-1", "all", {})).toBeUndefined();
  await client.cards("p-1", "all");
  await client.session();
  expect(client.cachedCards("p-1", "all", {})).toBeUndefined();
});
