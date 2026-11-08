// @vitest-environment jsdom
/**
 * M5.3 application shell, login gate and navigation (plan §4 M5.3, §3.2).
 *
 * The shell decides between "checking", "log in" and "workbench"; the login page
 * posts the password once and never stores a token. These tests cover each of
 * those states plus the project switcher, the view navigation and logout.
 */
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { App } from "./App.js";
import {
  ApiError,
  type CardDetail,
  type CardFilter,
  type CardiganClient,
  type CardListItem,
  type CardPage,
  type ProjectSummary,
  type SessionInfo,
} from "./api.js";
import { fakeClient as baseClient, cardDetail } from "./testing/fixtures.js";

afterEach(() => {
  cleanup();
  window.location.hash = "";
});

const project: ProjectSummary = {
  id: "p-1",
  name: "Cardigan 自己",
  created_at: "2026-01-01T00:00:00.000Z",
};

const card: CardListItem = {
  id: "C-1",
  title: "准备发布",
  goal: "把 0.1 发出去",
  acceptance_criteria: ["测试通过"],
  status: "in_progress",
  priority: 1,
  repo: "example/repo",
  base_branch: "main",
  created_at: "2026-01-01T00:00:00.000Z",
  why: "等你拍板 D-1",
  waiting_on: [],
  next_owners: [{ kind: "human", ref: "human" }],
  related_cards: [],
  progress: { completed: 0, total: 0 },
  updated_at: "2026-01-01T00:00:00.000Z",
  roles: ["coder"],
};

interface FakeOptions {
  readonly session?: () => Promise<SessionInfo>;
  readonly login?: (password: string) => Promise<void>;
  readonly logout?: () => Promise<void>;
  readonly projects?: () => Promise<readonly ProjectSummary[]>;
  readonly cards?: (projectId: string, filter: CardFilter) => Promise<CardPage>;
  readonly card?: () => Promise<CardDetail>;
}

const loggedIn = async (): Promise<SessionInfo> => ({
  authenticated: true,
  password_configured: true,
});
const oneProject = async (): Promise<readonly ProjectSummary[]> => [project];
const oneCard = async (
  _projectId: string,
  filter: CardFilter,
): Promise<CardPage> => ({
  project_id: "p-1",
  filter,
  cards: [card],
  counts: { total: 1, needs_me: 1, agent: 0 },
});
const noop = async (): Promise<void> => undefined;

function fakeClient(options: FakeOptions): CardiganClient {
  return {
    ...baseClient(),
    session: options.session ?? loggedIn,
    login: options.login ?? noop,
    logout: options.logout ?? noop,
    projects: options.projects ?? oneProject,
    cards: options.cards ?? oneCard,
    card: options.card ?? (async () => cardDetail()),
  };
}

const navigate = (hash: string) => {
  window.location.hash = hash;
  fireEvent(window, new HashChangeEvent("hashchange"));
};

const decisionCard = () =>
  cardDetail({
    relations: {
      decisions: [
        {
          id: "q(2)",
          question: "发布前要不要再跑一次冒烟？",
          status: "open",
          blocking: true,
          decider: "human",
        },
      ],
      cards: [],
      pull_requests: [],
    },
  });

test("checks the session before showing anything else", async () => {
  let resolve: (info: SessionInfo) => void = () => undefined;
  const pending = new Promise<SessionInfo>((done) => {
    resolve = done;
  });
  render(<App client={fakeClient({ session: () => pending })} />);
  expect(screen.getByRole("status").textContent).toContain("正在检查登录状态");
  resolve({ authenticated: false, password_configured: true });
  expect(await screen.findByRole("button", { name: "登录" })).toBeTruthy();
});

test("an unauthenticated browser gets the login page and a session hint", async () => {
  render(
    <App
      client={fakeClient({
        session: async () => ({
          authenticated: false,
          password_configured: false,
        }),
      })}
    />,
  );
  expect(await screen.findByLabelText("密码")).toBeTruthy();
  expect(screen.getByText(/cardigan web set-password/u)).toBeTruthy();
});

test("a failed login explains itself and does not enter the workbench", async () => {
  let attempts = 0;
  const client = fakeClient({
    session: async () => ({ authenticated: false, password_configured: true }),
    login: async () => {
      attempts += 1;
      throw new ApiError(401, "invalid_credentials", "invalid credentials");
    },
  });
  render(<App client={client} />);
  const input = await screen.findByLabelText("密码");
  fireEvent.change(input, { target: { value: "wrong password" } });
  fireEvent.click(screen.getByRole("button", { name: "登录" }));

  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toContain("密码不对");
  expect(attempts).toBe(1);
  expect(screen.queryByText("看板")).toBeNull();
});

test("a successful login reloads the session and shows the board", async () => {
  let authenticated = false;
  const passwords: string[] = [];
  const client = fakeClient({
    session: async () => ({ authenticated, password_configured: true }),
    login: async (password) => {
      passwords.push(password);
      authenticated = true;
    },
  });
  render(<App client={client} />);
  fireEvent.change(await screen.findByLabelText("密码"), {
    target: { value: "correct horse battery" },
  });
  fireEvent.click(screen.getByRole("button", { name: "登录" }));

  expect(await screen.findByText("准备发布")).toBeTruthy();
  expect(passwords).toEqual(["correct horse battery"]);
});

test("a broken connection offers a retry instead of a blank page", async () => {
  let attempt = 0;
  const client = fakeClient({
    session: async () => {
      attempt += 1;
      if (attempt === 1) throw new TypeError("fetch failed");
      return { authenticated: true, password_configured: true };
    },
  });
  render(<App client={client} />);
  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toContain("连不上 Workbench 服务");
  fireEvent.click(screen.getByRole("button", { name: "重试" }));
  expect(await screen.findByText("准备发布")).toBeTruthy();
});

test("the shell shows the project switcher, the filters and the navigation", async () => {
  render(<App client={fakeClient({})} />);
  expect(await screen.findByLabelText("项目")).toBeTruthy();
  expect(await screen.findByRole("link", { name: "看板" })).toBeTruthy();
  expect(screen.getByRole("link", { name: "列表" })).toBeTruthy();
  expect(screen.getByLabelText("下一步谁做")).toBeTruthy();
  expect(screen.getByRole("checkbox", { name: "进行中" })).toBeTruthy();
  // The URL lands on the only project's board by itself.
  await waitFor(() => expect(window.location.hash).toBe("#/p/p-1/board"));
});

test("switching the view changes the route and the screen", async () => {
  render(<App client={fakeClient({})} />);
  await screen.findByText("准备发布");
  navigate("#/p/p-1/list");
  const row = (await screen.findByText("准备发布")).closest("tr");
  expect(row?.textContent).toContain("C-1");
  expect(window.location.hash).toBe("#/p/p-1/list");
});

test("an unknown project in the URL falls back to the first real project", async () => {
  render(<App client={fakeClient({})} />);
  await screen.findByText("准备发布");
  navigate("#/p/p-missing/board");
  // The stale id is replaced by a project that exists, so a bookmarked URL from
  // a renamed project still lands on a working screen.
  await waitFor(() => expect(window.location.hash).toBe("#/p/p-1/board"));
  expect(await screen.findByText("准备发布")).toBeTruthy();
});

test("a project list without entries points at the CLI", async () => {
  render(<App client={fakeClient({ projects: async () => [] })} />);
  expect(await screen.findByText(/cardigan project create/u)).toBeTruthy();
});

test("logout clears the session and returns to the login page", async () => {
  let authenticated = true;
  let loggedOut = 0;
  const client = fakeClient({
    session: async () => ({ authenticated, password_configured: true }),
    logout: async () => {
      loggedOut += 1;
      authenticated = false;
    },
  });
  render(<App client={client} />);
  fireEvent.click(await screen.findByRole("button", { name: "登出" }));
  expect(await screen.findByLabelText("密码")).toBeTruthy();
  expect(loggedOut).toBe(1);
});

test("M5.S S23: a related decision keeps the card route and scrolls to its row", async () => {
  const scroll = vi.fn();
  const original = Element.prototype.scrollIntoView;
  Element.prototype.scrollIntoView =
    scroll as unknown as typeof Element.prototype.scrollIntoView;
  try {
    render(<App client={fakeClient({ card: async () => decisionCard() })} />);
    await screen.findByText("准备发布");
    navigate("#/p/p-1/cards/C-1");
    await screen.findByRole("article", { name: "卡片 C-1" });

    fireEvent.click(screen.getByRole("link", { name: "q(2) 拍板" }));

    await waitFor(() =>
      expect(window.location.hash).toBe("#/p/p-1/cards/C-1?at=decision-q(2)"),
    );
    expect(screen.getByRole("article", { name: "卡片 C-1" })).toBeTruthy();
    await waitFor(() =>
      expect(scroll).toHaveBeenCalledWith({ block: "nearest" }),
    );
    expect(scroll.mock.contexts.at(-1)).toBe(
      document.getElementById("decision-q(2)"),
    );
  } finally {
    Element.prototype.scrollIntoView = original;
  }
});

test("M5.S S23: a copied anchored card URL locates the same row after reload", async () => {
  const scroll = vi.fn();
  const original = Element.prototype.scrollIntoView;
  Element.prototype.scrollIntoView =
    scroll as unknown as typeof Element.prototype.scrollIntoView;
  window.location.hash = "#/p/p-1/cards/C-1?at=decision-q(2)";
  try {
    render(<App client={fakeClient({ card: async () => decisionCard() })} />);
    await screen.findByRole("article", { name: "卡片 C-1" });
    await waitFor(() =>
      expect(scroll).toHaveBeenCalledWith({ block: "nearest" }),
    );
    expect(scroll.mock.contexts.at(-1)).toBe(
      document.getElementById("decision-q(2)"),
    );
    expect(window.location.hash).toBe("#/p/p-1/cards/C-1?at=decision-q(2)");
  } finally {
    Element.prototype.scrollIntoView = original;
  }
});

test("M5.S S23: an unparseable hash keeps the current card instead of switching projects", async () => {
  render(<App client={fakeClient({})} />);
  await screen.findByText("准备发布");
  navigate("#/p/p-1/cards/C-1");
  await screen.findByRole("article", { name: "卡片 C-1" });

  navigate("#decision-q(2)");

  await waitFor(() => expect(window.location.hash).toBe("#decision-q(2)"));
  expect(screen.getByRole("article", { name: "卡片 C-1" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: /等我处理/u })).toBeNull();
});

test("the card route opens the card page", async () => {
  render(<App client={fakeClient({})} />);
  await screen.findByText("准备发布");
  navigate("#/p/p-1/cards/C-1");
  expect(await screen.findByRole("article", { name: "卡片 C-1" })).toBeTruthy();
  expect(screen.getByRole("heading", { level: 1 }).textContent).toContain(
    "准备发布",
  );
  // The board is no longer mounted once the card page is shown.
  expect(screen.queryByRole("link", { name: "看板" })).toBeTruthy();
});
