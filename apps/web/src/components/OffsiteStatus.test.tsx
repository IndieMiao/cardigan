// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
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

test("C-628: the event-loop delay of the sync and the server is shown, and a slow loop alerts", async () => {
  render(
    <OffsiteStatusSection
      client={client(
        view({
          alerts: ["loop_slow"],
          loop_delay: {
            sync: { p99_ms: 312.4, max_ms: 840, window_ms: 60_000 },
            server: { p99_ms: 11.6, max_ms: 20.2, window_ms: 60_000 },
          },
        }),
      )}
    />,
  );
  expect(await screen.findByText("事件循环延迟过高")).toBeTruthy();
  expect(
    screen.getByText(
      "同步进程 p99 312 ms · 最大 840 ms；服务进程 p99 12 ms · 最大 20 ms",
    ),
  ).toBeTruthy();
});

test("C-807: a bucket refusing browser uploads is an alert with the rule to add", async () => {
  render(
    <OffsiteStatusSection
      client={client(
        view({
          alerts: ["cors_blocked"],
          cors: {
            checked_at: "2026-11-27T03:00:00.000Z",
            origins: [
              {
                origin: "https://gs66.example.ts.net",
                verdict: "not_allowed",
                status: 403,
              },
            ],
            blocked: {
              reason: "not_allowed",
              rule: {
                origins: ["https://gs66.example.ts.net"],
                methods: ["PUT", "GET", "HEAD"],
                headers: ["content-type", "x-oss-forbid-overwrite"],
              },
            },
          },
        }),
      )}
    />,
  );
  const rule = await screen.findByRole("region", {
    name: "存储桶未允许本站跨域上传",
  });
  expect(
    screen.getAllByText("存储桶未允许本站跨域上传").length,
  ).toBeGreaterThanOrEqual(2);
  expect(screen.getByText(/^未允许/u)).toBeTruthy();
  expect(
    within(rule).getByText("跨域规则不包含本站来源、方法或请求头"),
  ).toBeTruthy();
  expect(within(rule).getByText("https://gs66.example.ts.net")).toBeTruthy();
  expect(within(rule).getByText("content-type")).toBeTruthy();
  cleanup();
  render(
    <OffsiteStatusSection
      client={client(
        view({
          cors: {
            checked_at: "2026-11-27T03:00:00.000Z",
            origins: [{ origin: "https://gs66.example.ts.net", verdict: "ok" }],
          },
        }),
      )}
    />,
  );
  expect(await screen.findByText("正常")).toBeTruthy();
  expect(screen.getByText(/^已允许/u)).toBeTruthy();
  expect(
    screen.queryByRole("region", { name: "存储桶未允许本站跨域上传" }),
  ).toBeNull();
});
