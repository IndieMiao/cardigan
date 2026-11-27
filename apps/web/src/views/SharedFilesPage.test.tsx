// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import type {
  SharedFilesClient,
  SharedListingView,
} from "../shared-files-api.js";
import { SharedFilesPage } from "./SharedFilesPage.js";

afterEach(() => {
  cleanup();
  window.location.hash = "";
});

const human = { kind: "human", member_id: "M-1" } as const;
const coder = {
  kind: "assignment",
  project_id: "alpha",
  assignment_id: "A-7",
  role_id: "coder",
} as const;

function listing(
  path: string,
  extra: Partial<SharedListingView> = {},
): SharedListingView {
  return {
    availability: "ready",
    notice: "共享文件库各项目都能看到，不要放密钥和凭据。",
    path,
    dirs:
      path === ""
        ? [
            {
              path: "art",
              created_at: "2026-11-24T00:00:00Z",
              created_by: human,
            },
          ]
        : [],
    files:
      path === "art"
        ? [
            {
              id: "SF-1",
              path: "art/hero.glb",
              name: "hero.glb",
              version_count: 2,
              current: {
                id: "v2",
                path: "art/hero.glb",
                size: 3 * 1024 * 1024,
                sha256: null,
                content_type: "model/gltf-binary",
                created_by: coder,
                committed_at: "2026-11-24T01:00:00Z",
              },
            },
          ]
        : [],
    ...extra,
  };
}

function client(overrides: Partial<SharedFilesClient> = {}) {
  const calls: string[] = [];
  const fake: SharedFilesClient = {
    list: vi.fn(async (path: string) => listing(path)),
    versions: vi.fn(async () => ({ versions: [] })),
    mkdir: vi.fn(async (path: string) => {
      calls.push(`mkdir ${path}`);
    }),
    beginUpload: vi.fn(async (input) => {
      calls.push(`begin ${input.path} ${input.size} ${input.content_type}`);
      return {
        upload_id: "u-1",
        method: "PUT" as const,
        url: "https://bucket.example/shared/u-1?sig",
        headers: { "content-type": input.content_type ?? "" },
      };
    }),
    put: vi.fn(async (ticket, _file, progress) => {
      progress(0.5);
      calls.push(`put ${ticket.url}`);
    }),
    commit: vi.fn(async (id: string) => {
      calls.push(`commit ${id}`);
    }),
    remove: vi.fn(async (path: string, kind: "file" | "dir") => {
      calls.push(`remove ${kind} ${path}`);
    }),
    downloadHref: (path, version) =>
      `/api/shared-files/download?path=${encodeURIComponent(path)}${version ? `&version=${version}` : ""}`,
    ...overrides,
  };
  return { fake, calls };
}

test("C-685: browses directories with the reminder, writer and size; downloads link to the host redirect", async () => {
  const { fake } = client();
  render(<SharedFilesPage projectId="alpha" client={fake} />);
  expect(
    await screen.findByText("共享文件库各项目都能看到，不要放密钥和凭据。"),
  ).toBeTruthy();
  fireEvent.click(await screen.findByRole("link", { name: "art/" }));
  await waitFor(() => expect(fake.list).toHaveBeenLastCalledWith("art"));
  const row = (await screen.findByText("hero.glb")).closest("tr");
  if (!row) throw new Error("row");
  expect(within(row).getByText("3.0 MiB")).toBeTruthy();
  expect(within(row).getByText("A-7（alpha · coder）")).toBeTruthy();
  expect(
    within(row).getByRole("link", { name: "下载" }).getAttribute("href"),
  ).toBe("/api/shared-files/download?path=art%2Fhero.glb");
  expect(window.location.hash).toContain("shared-files?path=art");
});

test("C-685: uploads go begin → PUT to storage → commit, into the current directory", async () => {
  window.location.hash = "#/p/alpha/shared-files?path=art";
  const { fake, calls } = client();
  render(<SharedFilesPage projectId="alpha" client={fake} />);
  await screen.findByText("hero.glb");
  const input = screen.getByLabelText("上传") as HTMLInputElement;
  const file = new File(["video"], "clip.mp4", { type: "video/mp4" });
  fireEvent.change(input, { target: { files: [file] } });
  await waitFor(() =>
    expect(calls).toEqual([
      "begin art/clip.mp4 5 video/mp4",
      "put https://bucket.example/shared/u-1?sig",
      "commit u-1",
    ]),
  );
  expect(await screen.findByText("已上传")).toBeTruthy();
});

test("C-685: dropping files uploads them; new directories and deletion go through dialogs", async () => {
  const { fake, calls } = client();
  render(<SharedFilesPage projectId="alpha" client={fake} />);
  const region = await screen.findByRole("region", { name: "共享文件" });
  await screen.findByText("art/");
  fireEvent.drop(region, {
    dataTransfer: {
      files: [new File(["a"], "a.png", { type: "image/png" })],
      types: ["Files"],
    },
  });
  await waitFor(() => expect(calls).toContain("commit u-1"));
  expect(calls[0]).toBe("begin a.png 1 image/png");

  fireEvent.click(screen.getByRole("button", { name: "新建目录" }));
  fireEvent.change(await screen.findByLabelText("目录名"), {
    target: { value: "视频" },
  });
  fireEvent.click(screen.getByRole("button", { name: "创建" }));
  await waitFor(() => expect(calls).toContain("mkdir 视频"));

  const row = (await screen.findByText("art/")).closest("tr");
  if (!row) throw new Error("row");
  fireEvent.click(within(row).getByRole("button", { name: "删除" }));
  const dialog = await screen.findByRole("dialog");
  fireEvent.click(within(dialog).getByRole("button", { name: "删除" }));
  await waitFor(() => expect(calls).toContain("remove dir art"));
});

test("C-685: without storage the page says so and offers no upload", async () => {
  const { fake } = client({
    list: vi.fn(async (path: string) =>
      listing(path, { availability: "not_configured", dirs: [] }),
    ),
  });
  render(<SharedFilesPage projectId="alpha" client={fake} />);
  expect(await screen.findByText("未配置私有存储")).toBeTruthy();
  expect(
    (screen.getByRole("button", { name: "上传" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  expect(
    (screen.getByRole("button", { name: "新建目录" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
});

const corsBlocked = {
  reason: "not_enabled" as const,
  rule: {
    origins: ["https://gs66.example.ts.net"],
    methods: ["PUT", "GET", "HEAD"],
    headers: ["content-type", "x-oss-forbid-overwrite"],
  },
};

test("C-807: a bucket refusing browser uploads shows the reason and the rule to add", async () => {
  const { fake } = client({
    list: vi.fn(async (path: string) =>
      listing(path, { cors_blocked: corsBlocked }),
    ),
  });
  render(<SharedFilesPage projectId="alpha" client={fake} />);
  const alert = await screen.findByRole("alert", {
    name: "存储桶未允许本站跨域上传",
  });
  expect(within(alert).getByText("存储桶没有开启跨域（CORS）")).toBeTruthy();
  expect(within(alert).getByText("https://gs66.example.ts.net")).toBeTruthy();
  expect(within(alert).getByText("PUT、GET、HEAD")).toBeTruthy();
  expect(within(alert).getByText("x-oss-forbid-overwrite")).toBeTruthy();
});

test("C-807: a network error after a refused preflight names the CORS rule, not the connection", async () => {
  const { ApiError } = await import("../api.js");
  const unreachable = () =>
    Promise.reject(
      new ApiError(0, "storage_unreachable", "无法连接存储，上传未完成"),
    );
  const blocked = client({
    list: vi.fn(async (path: string) =>
      listing(path, { cors_blocked: corsBlocked }),
    ),
    put: vi.fn(unreachable),
  });
  render(<SharedFilesPage projectId="alpha" client={blocked.fake} />);
  await screen.findByText("art/");
  fireEvent.change(screen.getByLabelText("上传"), {
    target: { files: [new File(["a"], "a.png", { type: "image/png" })] },
  });
  expect(
    await screen.findByText(
      "请求失败：存储桶未允许本站跨域上传（存储桶没有开启跨域（CORS）），上传未完成",
    ),
  ).toBeTruthy();
  cleanup();
  // Without a refused preflight the original message stays.
  const plain = client({ put: vi.fn(unreachable) });
  render(<SharedFilesPage projectId="alpha" client={plain.fake} />);
  await screen.findByText("art/");
  fireEvent.change(screen.getByLabelText("上传"), {
    target: { files: [new File(["a"], "a.png", { type: "image/png" })] },
  });
  expect(
    await screen.findByText("请求失败：无法连接存储，上传未完成"),
  ).toBeTruthy();
});
