import type { Stats } from "node:fs";
import { type FileHandle, lstat, open } from "node:fs/promises";
import type { ServerResponse } from "node:http";
import { beforeEach, expect, test, vi } from "vitest";
import { HttpRejection } from "./http.js";
import { serveMergeCheckLog } from "./merge-check-log.js";

vi.mock("node:fs/promises", () => ({ lstat: vi.fn(), open: vi.fn() }));
beforeEach(() => vi.resetAllMocks());

function fixture() {
  const file = {
    stat: vi.fn(async () => ({ isFile: () => true, size: 5 })),
    read: vi.fn(
      async (
        buffer: Buffer,
        offset: number,
        length: number,
        position: number,
      ) => ({
        // Simulate short reads and appended output beyond the stat snapshot.
        bytesRead: buffer.write(
          "hello appended".slice(position, position + Math.min(length, 2)),
          offset,
        ),
      }),
    ),
    close: vi.fn(async () => undefined),
  };
  vi.mocked(lstat).mockResolvedValue({ isDirectory: () => true } as Stats);
  vi.mocked(open).mockResolvedValue(file as unknown as FileHandle);
  const res = { setHeader: vi.fn(), writeHead: vi.fn(), end: vi.fn() };
  const input = {
    res: res as unknown as ServerResponse,
    dataDir: "/unused-log-fixture",
    projectId: "p-test",
    attempt: "e42de008-2c67-49e2-a59d-077a0f7936de",
    hasAttempt: vi.fn(() => true),
    authorize: vi.fn<() => unknown>(() => undefined),
  };
  return { input, res, file };
}

test("authorization failure prevents any log lookup or filesystem access", async () => {
  const { input, res } = fixture();
  const denied = new HttpRejection(401, "unauthorized", "请先登录。");
  input.authorize.mockImplementation(() => {
    throw denied;
  });
  await expect(serveMergeCheckLog(input)).rejects.toBe(denied);
  expect(input.hasAttempt).not.toHaveBeenCalled();
  expect(lstat).not.toHaveBeenCalled();
  expect(open).not.toHaveBeenCalled();
  expect(res.end).not.toHaveBeenCalled();
});

test("short reads preserve the snapshot and authorize before IO and before sending", async () => {
  const { input, res, file } = fixture();
  vi.mocked(lstat).mockImplementation(async () => {
    expect(input.authorize).toHaveBeenCalledTimes(1);
    return { isDirectory: () => true } as Stats;
  });
  input.authorize
    .mockImplementationOnce(() => undefined)
    .mockImplementationOnce(() => {
      expect(file.close).toHaveBeenCalledOnce();
      expect(res.end).not.toHaveBeenCalled();
    });
  await serveMergeCheckLog(input);
  expect(res.end).toHaveBeenCalledWith(Buffer.from("hello"));
  expect(file.read).toHaveBeenCalledTimes(3);
  expect(input.authorize).toHaveBeenCalledTimes(2);
});

test("a session revoked during the read cannot receive the log", async () => {
  const { input, res, file } = fixture();
  const denied = new HttpRejection(401, "unauthorized", "请先登录。");
  input.authorize
    .mockImplementationOnce(() => undefined)
    .mockImplementationOnce(() => {
      throw denied;
    });
  await expect(serveMergeCheckLog(input)).rejects.toBe(denied);
  expect(file.read).toHaveBeenCalled();
  expect(file.close).toHaveBeenCalledOnce();
  expect(res.writeHead).not.toHaveBeenCalled();
  expect(res.end).not.toHaveBeenCalled();
});
