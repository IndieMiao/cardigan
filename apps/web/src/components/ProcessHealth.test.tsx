// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import type { CardiganClient, ProcessHealthView } from "../api.js";
import { ProcessHealthSection } from "./ProcessHealth.js";

afterEach(cleanup);

const GIB = 1024 ** 3;
const client = (view: ProcessHealthView) =>
  ({ processHealth: async () => view }) as unknown as CardiganClient;

test("C-638: the control host shows each process's heap against its limit", async () => {
  const { container } = render(
    <ProcessHealthSection
      client={client({
        processes: [
          {
            role: "web",
            heap_used_bytes: 1.5 * GIB,
            heap_limit_bytes: 4 * GIB,
            rss_bytes: 2.4 * GIB,
            checked_at: "2026-11-23T08:00:00.000Z",
          },
          {
            role: "background",
            heap_used_bytes: 2.5 * GIB,
            heap_limit_bytes: 4 * GIB,
            rss_bytes: 2.8 * GIB,
            checked_at: "2026-11-23T07:59:30.000Z",
          },
        ],
      })}
    />,
  );
  expect(await screen.findByText("网页进程")).toBeTruthy();
  expect(screen.getByText("后台进程")).toBeTruthy();
  expect(container.textContent).toContain("堆 1.5 GiB / 4.0 GiB · RSS 2.4 GiB");
  expect(container.textContent).toContain("堆 2.5 GiB / 4.0 GiB · RSS 2.8 GiB");
});

test("C-835: each continuous run shows its heap growth, newest first", async () => {
  const MIB = 1024 ** 2;
  const segment = (
    boot_id: string,
    points: number,
    heap_growth_bytes_per_day: number | null,
  ) => ({
    boot_id,
    started_at: "2026-11-27T08:00:00.000Z",
    first_at: "2026-11-27T09:00:00.000Z",
    last_at: "2026-11-27T12:00:00.000Z",
    points,
    heap_growth_bytes_per_day,
  });
  const base = {
    heap_used_bytes: GIB,
    heap_limit_bytes: 8 * GIB,
    rss_bytes: 2 * GIB,
    checked_at: "2026-11-27T12:00:00.000Z",
  };
  const { container } = render(
    <ProcessHealthSection
      client={client({
        processes: [
          {
            role: "web",
            ...base,
            history: {
              points: [],
              segments: [segment("a", 4, 52.4 * MIB), segment("b", 1, null)],
            },
          },
          {
            role: "background",
            ...base,
            history: { points: [], segments: [] },
          },
        ],
      })}
    />,
  );
  const web = (await screen.findByText("网页进程堆增长")).parentElement;
  expect(web?.textContent).toMatch(/1 点 · 无法计算.*4 点 · 52\.4 MB\/天/);
  expect(screen.getByText("后台进程堆增长").parentElement?.textContent).toBe(
    "后台进程堆增长无记录",
  );
  expect(container.textContent).not.toContain("NaN");
});
