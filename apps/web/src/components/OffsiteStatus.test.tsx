// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import type { CardiganClient, OffsiteStatusView } from "../api.js";
import { formatBytes, OffsiteStatusSection } from "./OffsiteStatus.js";

afterEach(cleanup);

const view = (patch: Partial<OffsiteStatusView> = {}): OffsiteStatusView => ({
  configured: "ready",
  bucket: "cardigan-attachments",
  region: "us-west-1",
  synced: { count: 7475, bytes: 4.1 * 1024 ** 3 },
  pending: { count: 3, bytes: 2048 },
  failed: { count: 0 },
  last_success_at: "2026-11-23T03:00:00.000Z",
  usage: {
    month: "2026-11",
    egress_bytes: 1024 ** 3,
    process_bytes: 0,
    requests: 12,
    estimated_yuan: 1.08,
    budget_yuan: 50,
  },
  alerts: [],
  ...patch,
});
const client = (status: OffsiteStatusView | null) =>
  ({ offsiteStatus: async () => status }) as unknown as CardiganClient;

test("C-614: the control host shows backlog, failures and the monthly estimate", async () => {
  render(<OffsiteStatusSection client={client(view())} />);
  expect(await screen.findByText("正常")).toBeTruthy();
  expect(screen.getByText("7475 个 · 4.1 GiB")).toBeTruthy();
  expect(screen.getByText("3 个 · 2.0 KiB")).toBeTruthy();
  expect(screen.getByText("¥1.08 / 上限 ¥50")).toBeTruthy();
});

test("C-614: alerts are named, and an unconfigured host says so", async () => {
  render(
    <OffsiteStatusSection
      client={client(
        view({
          alerts: ["unreachable", "over_budget"],
          failed: { count: 2, last_code: "network" },
        }),
      )}
    />,
  );
  expect(await screen.findByText("OSS 不可达、超出月度上限")).toBeTruthy();
  expect(screen.getByText("2 · network")).toBeTruthy();
  cleanup();
  render(
    <OffsiteStatusSection
      client={client(
        view({ configured: "absent", bucket: undefined, region: undefined }),
      )}
    />,
  );
  expect(await screen.findByText("未配置")).toBeTruthy();
});

test("byte sizes use binary units", () => {
  expect(formatBytes(512)).toBe("512 B");
  expect(formatBytes(1536)).toBe("1.5 KiB");
  expect(formatBytes(334 * 1024 ** 2)).toBe("334.0 MiB");
});
