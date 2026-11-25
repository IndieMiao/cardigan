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
