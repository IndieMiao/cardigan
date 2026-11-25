import { expect, test, vi } from "vitest";
import { HttpCardiganClient } from "./api.js";
import { cardDetail } from "./testing/fixtures.js";

const reply = (value: unknown, etag?: string) =>
  new Response(JSON.stringify(value), {
    status: 200,
    headers: {
      "content-type": "application/json",
      ...(etag ? { etag } : {}),
    },
  });
const notModified = (etag: string) =>
  new Response(null, { status: 304, headers: { etag } });
const sent = (fetch: ReturnType<typeof vi.fn>, call: number) =>
  new Headers(
    (fetch.mock.calls[call]?.[1] as RequestInit | undefined)?.headers,
  ).get("if-none-match");

test("C-688: an open detail revalidates with its validator and keeps the same object on 304", async () => {
  const overview = { ...cardDetail(), overview: { work_count: 1 } };
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValueOnce(reply(overview, '"one"'))
    .mockResolvedValueOnce(notModified('"one"'))
    .mockResolvedValueOnce(
      reply({ ...overview, card: { ...overview.card, title: "新" } }, '"two"'),
    )
    .mockResolvedValueOnce(reply({ work_items: [] }, '"panel"'))
    .mockResolvedValueOnce(notModified('"panel"'));
  const client = new HttpCardiganClient(fetch);
  const options = { section: "overview" as const, limit: 20 };
  const first = await client.card("p-1", "C-1", options);
  expect(sent(fetch, 0)).toBeNull();
  // The overview shape is applied once and reused as is.
  expect(first.work_items).toEqual([]);
  const second = await client.card("p-1", "C-1", options);
  expect(sent(fetch, 1)).toBe('"one"');
  expect(second).toBe(first);
  const third = await client.card("p-1", "C-1", options);
  expect(sent(fetch, 2)).toBe('"one"');
  expect(third).not.toBe(first);
  expect(third.card.title).toBe("新");

  const panel = await client.cardPanel("p-1", "C-1", "work");
  expect(sent(fetch, 3)).toBeNull();
  expect(await client.cardPanel("p-1", "C-1", "work")).toBe(panel);
  expect(sent(fetch, 4)).toBe('"panel"');
});

test("C-688: validators are per exact read and dropped when the session ends", async () => {
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValueOnce(reply(cardDetail(), '"one"'))
    .mockResolvedValueOnce(reply(cardDetail(), '"other"'))
    .mockResolvedValueOnce(
      new Response(JSON.stringify({ error: { code: "unauthorized" } }), {
        status: 401,
      }),
    )
    .mockResolvedValueOnce(reply(cardDetail(), '"one"'))
    // A 304 for a validator this client does not hold reads in full.
    .mockResolvedValueOnce(notModified('"stale"'))
    .mockResolvedValueOnce(reply(cardDetail(), '"three"'));
  const client = new HttpCardiganClient(fetch);
  await client.card("p-1", "C-1", { limit: 20 });
  await client.card("p-1", "C-1", { limit: 10 });
  expect(sent(fetch, 1)).toBeNull();
  await expect(client.card("p-1", "C-1", { limit: 10 })).rejects.toThrow();
  expect(sent(fetch, 2)).toBe('"other"');
  await client.card("p-1", "C-1", { limit: 20 });
  expect(sent(fetch, 3)).toBeNull();
  const full = await client.card("p-1", "C-1", { limit: 20 });
  expect(sent(fetch, 4)).toBe('"one"');
  expect(sent(fetch, 5)).toBeNull();
  expect(full.card.id).toBe("C-1");
});
