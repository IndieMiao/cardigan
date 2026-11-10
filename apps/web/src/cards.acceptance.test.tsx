// @vitest-environment node
/** M5.T1: M5.3 public components against real CLI/domain/MCP/HTTP state, per plan §3.2/§3.4/§3.7. */

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterAll, afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  type Attachment,
  type Delivery,
  recordDecision,
  requestDecision,
} from "../../../packages/domain/dist/index.js";
import {
  type BrowserFixture,
  browserFixture,
  decorate,
  deferred,
} from "../test-support/m5-browser.js";
import { App } from "./App.js";
import {
  ApiError,
  type CardDetail,
  type CardiganClient,
  type CardPage,
  type SessionInfo,
} from "./api.js";
import { CardDetailPage } from "./views/CardDetailPage.js";
import { CardListPage } from "./views/CardListPage.js";
import { LoginPage } from "./views/LoginPage.js";

// Keep native Node module URLs for the real CLI/Store while providing a DOM to React.
const browser = await vi.hoisted(async () => {
  // @ts-expect-error jsdom is an existing test-only dependency without bundled declarations.
  const { JSDOM } = await import("jsdom");
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: "http://localhost/",
  });
  const keys = [
    "window",
    "document",
    "navigator",
    "HTMLElement",
    "Node",
    "Event",
    "MouseEvent",
    "File",
    "Blob",
    "FileReader",
  ];
  const saved = keys.map(
    (key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const,
  );
  for (const key of keys)
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value: dom.window[key],
    });
  return {
    close: () => {
      dom.window.close();
      for (const [key, value] of saved) {
        if (value) Object.defineProperty(globalThis, key, value);
        else Reflect.deleteProperty(globalThis, key);
      }
    },
  };
});
afterAll(() => browser.close());

let f: BrowserFixture;
beforeEach(async () => {
  window.location.hash = "";
  f = await browserFixture();
});
afterEach(async () => {
  cleanup();
  await f?.close();
  vi.unstubAllGlobals();
}, 30_000);
const project = () => f.project.project_id;
const detail = (
  client: CardiganClient = f.client,
  cardId = f.card.id as string,
) =>
  render(
    <CardDetailPage client={client} projectId={project()} cardId={cardId} />,
  );
const textOf = (node: Element | null) => node?.textContent ?? "";

test("U01 §8.1: shell shows session loading, failure, login, then project navigation and real cards", async () => {
  const pending = deferred<SessionInfo>();
  const shell = render(
    <App client={decorate(f.client, { session: () => pending.promise })} />,
  );
  expect(screen.getByRole("status").textContent).toMatch(/加载|检查/);
  await act(async () => pending.reject(new Error("Session unavailable")));
  expect(screen.getByRole("alert").textContent).toContain(
    "Session unavailable",
  );
  shell.unmount();
  render(<App client={f.client} />);
  const password = await screen.findByLabelText(/密码/);
  fireEvent.change(password, { target: { value: f.passwordText } });
  fireEvent.click(screen.getByRole("button", { name: /登录/ }));
  await screen.findByRole("link", { name: new RegExp(f.card.title) });
  expect(screen.getByRole("combobox", { name: /项目/ })).toBeTruthy();
  for (const name of ["卡片", "Needs You", "项目快照", "执行视图", "项目动态"])
    expect(screen.getByRole("link", { name })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "列表" }));
  await waitFor(() =>
    expect(window.location.hash).toContain("/cards?view=list"),
  );
});

test("U02 §3.2: login explains missing password setup, reports bad passwords and succeeds through HTTP", async () => {
  const loggedIn = vi.fn();
  const page = render(
    <LoginPage
      client={f.client}
      passwordConfigured={false}
      onLoggedIn={loggedIn}
    />,
  );
  expect(screen.getByText(/cardigan web set-password/)).toBeTruthy();
  page.rerender(
    <LoginPage client={f.client} passwordConfigured onLoggedIn={loggedIn} />,
  );
  const input = screen.getByLabelText(/密码/);
  expect(input.getAttribute("type")).toBe("password");
  fireEvent.change(input, { target: { value: "incorrect password" } });
  fireEvent.click(screen.getByRole("button", { name: /登录/ }));
  expect(textOf(await screen.findByRole("alert"))).toMatch(/密码/);
  expect(loggedIn).not.toHaveBeenCalled();
  const pending = deferred<void>();
  page.rerender(
    <LoginPage
      client={decorate(f.client, {
        login: async (password) => {
          await pending.promise;
          await f.client.login(password);
        },
      })}
      passwordConfigured
      onLoggedIn={loggedIn}
    />,
  );
  fireEvent.change(input, { target: { value: f.passwordText } });
  fireEvent.click(screen.getByRole("button", { name: /登录/ }));
  expect(
    (screen.getByRole("button", { name: /登录/ }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  await act(async () => pending.resolve());
  await waitFor(() => expect(loggedIn).toHaveBeenCalledOnce());
  expect((await f.client.session()).authenticated).toBe(true);
});

test.each(["board", "list"] as const)(
  "U03 §8.1: %s handles loading, transport error, real data and empty projects with textual status",
  async (view) => {
    await f.loginBrowser();
    const pending = deferred<CardPage>();
    const page = render(
      <CardListPage
        projectId={project()}
        view={view}
        client={decorate(f.client, { cards: () => pending.promise })}
      />,
    );
    expect(textOf(screen.getByRole("status"))).toMatch(/加载/);
    await act(async () => pending.reject(new Error("Board unavailable")));
    expect(textOf(screen.getByRole("alert"))).toContain("Board unavailable");
    page.unmount();
    render(
      <CardListPage projectId={project()} view={view} client={f.client} />,
    );
    const link = await screen.findByRole("link", {
      name: new RegExp(f.card.title),
    });
    expect(link.getAttribute("href")).toContain(`/cards/${f.card.id}`);
    const beforeRead = f.state();
    const rows = await f.client.cards(project(), "all");
    const row = rows.cards.find((item) => item.id === f.card.id);
    const items = beforeRead.work_items.filter(
      (item) => item.card_id === f.card.id,
    );
    expect(row?.work_items).toEqual(
      items.map(({ id, title, status }) => ({ id, title, status })),
    );
    expect(row?.attachment_count).toBe(0);
    const assignments = items.flatMap((item) =>
      beforeRead.assignments.filter(
        (assignment) =>
          assignment.id === item.assignment_id &&
          assignment.status !== "released",
      ),
    );
    expect(row?.participants?.map((owner) => owner.author).sort()).toEqual(
      assignments.map((assignment) => `assignment:${assignment.id}`).sort(),
    );
    expect(
      row?.participants?.some((owner) => owner.author_role === "reviewer"),
    ).toBe(true);
    expect(JSON.stringify(row?.participants)).not.toContain("launch_profile");
    expect(f.state().events).toEqual(beforeRead.events);
    expect(f.state().cursors).toEqual(beforeRead.cursors);
    expect(screen.getAllByText(/待开始/).length).toBeGreaterThan(0);
    for (const name of [
      "状态：全部",
      "下一步：全部",
      "角色：全部",
      "排序：全部",
    ])
      expect(screen.getByRole("button", { name })).toBeTruthy();
    fireEvent.change(screen.getByLabelText("搜索标题或编号"), {
      target: { value: "没有这张卡" },
    });
    await screen.findByText("没有匹配的卡片，请调整筛选条件。");
    await waitFor(() =>
      expect(
        screen.queryByRole("link", { name: new RegExp(f.card.title) }),
      ).toBeNull(),
    );
    fireEvent.change(screen.getByLabelText("搜索标题或编号"), {
      target: { value: "" },
    });
    await screen.findByRole("link", { name: new RegExp(f.card.title) });
    cleanup();
    await f.cli("project", "create", "empty-board");
    render(
      <CardListPage projectId="empty-board" view={view} client={f.client} />,
    );
    expect(textOf(await screen.findByText(/没有卡片|暂无卡片/))).toMatch(
      /卡片/,
    );
  },
);

test("U04 §8.4: card detail handles loading, transport errors, missing cards and answers all five questions", async () => {
  // Both `findBy*` waits below are real HTTP + a full card render. The default
  // 1 s is an idle-machine budget: measured 15-54 ms for the missing-card reply
  // and 61-506 ms for the detail render here, and a loaded host multiplies that
  // by ~5. Wait on the condition with one explicit ceiling instead of guessing.
  const UI_WAIT = { timeout: 10_000 } as const;
  await f.loginBrowser();
  const pending = deferred<CardDetail>();
  let page = detail(decorate(f.client, { card: () => pending.promise }));
  expect(textOf(screen.getByRole("status"))).toMatch(/加载/);
  await act(async () => pending.reject(new Error("Card unavailable")));
  expect(textOf(screen.getByRole("alert"))).toContain("Card unavailable");
  page.unmount();
  page = detail(f.client, "C-999999");
  expect(
    textOf(await screen.findByText(/不存在|找不到/, undefined, UI_WAIT)),
  ).toMatch(/不存在|找不到/);
  page.unmount();
  const product = await f.deliver(
    f.primary,
    await f.change(f.primary.owner, "review.txt", "ready\n"),
  );
  await f.review(f.primary.verifier, product);
  await f.complete(product);
  detail();
  await screen.findByRole(
    "heading",
    { name: new RegExp(f.card.title) },
    UI_WAIT,
  );
  expect(screen.getByText(f.card.goal)).toBeTruthy();
  expect(screen.getAllByText(/等待合并|待合并/).length).toBeGreaterThan(0);
  expect(
    screen.getAllByText(/由你|等你|你来|下一步.*你/).length,
  ).toBeGreaterThan(0);
  const decision = f
    .state()
    .decisions.find((q) => q.trigger === "merge_confirmation");
  expect(textOf(screen.getByText("被什么阻塞").nextElementSibling)).toContain(
    decision?.id,
  );
  for (const criterion of f.card.acceptance_criteria)
    expect(
      screen.getAllByText(criterion, { exact: false }).length,
    ).toBeGreaterThan(0);
  expect(screen.getAllByText(/PM|pm/).length).toBeGreaterThan(0);
  expect(screen.getAllByText(/通过|已接受/).length).toBeGreaterThan(0);
  const acceptance = textOf(
    screen.getByText("谁验收、依据是什么").nextElementSibling,
  );
  expect(acceptance).toContain("pm");
  expect(acceptance).toContain("已通过");
}, 30_000);

test("merge return through HTTP rejects blank reasons and preserves the human explanation", async () => {
  await f.loginBrowser();
  const product = await f.deliver(
    f.primary,
    await f.change(f.primary.owner, "return.txt", "ready\n"),
  );
  await f.review(f.primary.verifier, product);
  await f.complete(product);
  const decision = f
    .state()
    .decisions.find((q) => q.trigger === "merge_confirmation");
  if (!decision) throw new Error("Missing confirmation");
  for (const reason of ["", " \n "])
    await expect(
      f.client.recordDecision(
        project(),
        decision.id,
        "request_changes",
        reason,
      ),
    ).rejects.toMatchObject({ code: "validation_failed" });
  expect(f.state().cards.find((c) => c.id === f.card.id)?.status).toBe(
    "awaiting_merge",
  );
  const reason = " 请补齐空输入校验 ";
  await f.client.recordDecision(
    project(),
    decision.id,
    "request_changes",
    reason,
  );
  expect(f.state().decisions.find((q) => q.id === decision.id)).toMatchObject({
    status: "resolved",
    resolution: {
      option: "request_changes",
      raw_quote: reason,
      rationale: reason,
      resolved_by: "human",
    },
  });
  expect(f.state().cards.find((c) => c.id === f.card.id)?.status).toBe(
    "in_progress",
  );
  expect(f.state().timeline).toContainEqual(
    expect.objectContaining({
      body: `退回修改：${reason}`,
      work_item_id: product.work_item_id,
    }),
  );
});

test("U05 §3.2: real Agent Markdown renders as text, with only web and local links and no executable HTML", async () => {
  await f.loginBrowser();
  await f.agentComment(
    'Attack marker\n\n<img src="x" onerror="window.xss=1"><script>window.xss=1</script>\n\n[js](javascript:alert(1)) [data](data:text/html,boom) [file](file:///tmp/a) [remote](//evil.example/a) [web](http://example.test/a) [secure](https://example.test/b) [local](/api/me)',
  );
  const page = detail();
  await screen.findByText(/Attack marker/);
  expect(
    page.container.querySelector("script, img[src='x'], [onerror]"),
  ).toBeNull();
  for (const name of ["js", "data", "file", "remote"])
    expect(screen.queryByRole("link", { name })).toBeNull();
  for (const [name, href] of [
    ["web", "http://example.test/a"],
    ["secure", "https://example.test/b"],
    ["local", "/api/me"],
  ] as const)
    expect(screen.getByRole("link", { name }).getAttribute("href")).toBe(href);
  expect(
    screen.getByRole("link", { name: "secure" }).getAttribute("rel"),
  ).toContain("noopener");
});

async function prDelivery() {
  const sha = await f.change(f.primary.owner, "pr.txt", "review\n");
  await f.start(f.primary.owner);
  return f.mcp<Delivery>(f.primary.owner, "submit_delivery", {
    work_item_id: f.primary.owner.work_item_id,
    kind: "code",
    summary: "PR evidence",
    subject: { kind: "git_head", value: sha },
    pr_url: "https://example.test/pull/1",
    requested_verifiers: [f.primary.verifier.work_item_id],
  });
}
test.each([
  "http://example.test/pull/1",
  "https://example.test/pull/2",
  "javascript:alert(1)",
  "data:text/html,boom",
  "/relative/pr",
])(
  "U06 §3.2: PR link %s is clickable only for an absolute http(s) URL",
  async (url) => {
    await f.loginBrowser();
    await prDelivery();
    const original = await f.client.card(project(), f.card.id);
    // Current domain rejects unsafe URLs. Exercise the UI boundary with an untrusted/legacy API value,
    // preserving every real entity and changing only pr_url; never inject business rows into Store.
    const response: CardDetail = {
      ...original,
      deliveries: original.deliveries.map((d) => ({ ...d, pr_url: url })),
      relations: {
        ...original.relations,
        pull_requests: original.relations.pull_requests.map((pr) => ({
          ...pr,
          pr_url: url,
        })),
      },
    };
    const page = detail(decorate(f.client, { card: async () => response }));
    await screen.findByRole("heading", { name: new RegExp(f.card.title) });
    const matching = [...page.container.querySelectorAll("a")].filter(
      (a) => a.getAttribute("href") === url || a.textContent === url,
    );
    expect(matching.length > 0).toBe(/^https?:/.test(url));
  },
);

test("U07 §3.4: only existing server-resolved numbers in an Agent comment become links", async () => {
  await f.loginBrowser();
  const text = `${f.card.id} C-999999 ${f.primary.owner.work_item_id} W-999999`;
  await f.agentComment(text);
  const response = await f.client.card(project(), f.card.id);
  const entry = response.timeline.find((e) => e.body === text) as unknown as {
    references: { id: string; exists: boolean }[];
  };
  expect(entry.references).toContainEqual(
    expect.objectContaining({ id: "C-999999", exists: false }),
  );
  const page = detail();
  await screen.findByText(/C-999999/, { exact: false });
  const bad = [...page.container.querySelectorAll("a")].filter((a) =>
    /C-999999|W-999999/.test(a.textContent ?? ""),
  );
  expect(bad).toEqual([]);
  const existing = [...page.container.querySelectorAll("a")].filter(
    (a) => a.textContent === `${f.card.id} 卡片`,
  );
  expect(existing.length).toBeGreaterThan(0);
});

test("U08 §3.7: comment preview, mention completion and pasted image post through the public HTTP commands", async () => {
  await f.loginBrowser();
  detail();
  const input = await screen.findByRole("textbox", { name: /评论|内容/ });
  fireEvent.change(input, { target: { value: "**Review this** @" } });
  const suggestion = await screen.findByRole("button", {
    name: new RegExp(f.primary.owner.id),
  });
  fireEvent.click(suggestion);
  expect((input as HTMLTextAreaElement).value).toContain(
    `@${f.primary.owner.id}`,
  );
  const file = new File(["image evidence"], "evidence.png", {
    type: "image/png",
  });
  fireEvent.paste(input, {
    clipboardData: {
      files: [file],
      items: [{ kind: "file", type: "image/png", getAsFile: () => file }],
    },
  });
  fireEvent.click(screen.getByRole("tab", { name: /预览/ }));
  expect(screen.getByText("Review this").tagName).toBe("STRONG");
  fireEvent.click(screen.getByRole("button", { name: /^发表|^发送|提交评论/ }));
  await waitFor(() =>
    expect(
      f
        .state()
        .timeline.some(
          (e) => e.author === "human" && e.body.includes("Review this"),
        ),
    ).toBe(true),
  );
  await waitFor(() => expect(f.state().attachments).toHaveLength(1));
  const attachment = f.state().attachments[0];
  expect(attachment?.mime).toBe("image/png");
  const posted = f
    .state()
    .timeline.find((e) => e.id === attachment?.attach_to.id);
  expect(posted?.mentions).toContain(f.primary.owner.id);
});

test("U09 §3.7: a failed comment keeps its draft and queued image, then retry writes once", async () => {
  await f.loginBrowser();
  let fail = true;
  detail(
    decorate(f.client, {
      addComment: (...args) =>
        fail
          ? Promise.reject(new ApiError(503, "unavailable", "Try again"))
          : f.client.addComment(...args),
    }),
  );
  const input = await screen.findByRole("textbox", { name: /评论|内容/ });
  fireEvent.change(input, { target: { value: "Keep this draft" } });
  const file = new File(["retry evidence"], "retry.png", { type: "image/png" });
  fireEvent.paste(input, {
    clipboardData: {
      files: [file],
      items: [{ kind: "file", type: "image/png", getAsFile: () => file }],
    },
  });
  fireEvent.click(screen.getByRole("button", { name: /^发表|^发送|提交评论/ }));
  expect(textOf(await screen.findByRole("alert"))).toContain("服务暂时异常");
  expect(textOf(screen.getByRole("alert"))).toContain("可能已经成功");
  expect((input as HTMLTextAreaElement).value).toBe("Keep this draft");
  expect(screen.getByText(/retry.png/)).toBeTruthy();
  expect(f.state().attachments).toHaveLength(0);
  fail = false;
  fireEvent.click(screen.getByRole("button", { name: /^发表|^发送|提交评论/ }));
  await waitFor(() => expect(f.state().attachments).toHaveLength(1));
  expect(
    f.state().timeline.filter((e) => e.body === "Keep this draft"),
  ).toHaveLength(1);
});

test.each([false, true])(
  "C-20: lost comment response, edited retry and fresh submission recover without remounting (drawer=%s)",
  async (inDrawer) => {
    await f.loginBrowser();
    const old = await f.client.addComment(project(), f.card.id, {
      body: "之前的评论",
    });
    const addComment = vi
      .fn<CardiganClient["addComment"]>()
      .mockImplementation(async (...args) => {
        const receipt = await f.client.addComment(...args);
        if (addComment.mock.calls.length === 1)
          throw new DOMException("Response lost after commit", "TimeoutError");
        return receipt;
      });
    const read = vi
      .fn<CardiganClient["card"]>()
      .mockImplementation((...args) => f.client.card(...args));
    render(
      <CardDetailPage
        client={decorate(f.client, { addComment, card: read })}
        projectId={project()}
        cardId={f.card.id}
        inDrawer={inDrawer}
        anchor={`entry-${old.id}`}
      />,
    );
    const input = (await screen.findByLabelText(
      "评论正文",
    )) as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "最初评论" } });
    fireEvent.click(screen.getByRole("button", { name: "发表评论" }));
    expect(textOf(await screen.findByRole("alert"))).toContain("可能已经成功");
    expect(
      screen.queryByText("最初评论", { selector: ".timeline-records p" }),
    ).toBeNull();
    fireEvent.change(input, { target: { value: "编辑后的评论" } });
    fireEvent.click(screen.getByRole("button", { name: "发表评论" }));
    await screen.findByText(/上一次的评论已经发表/u);
    await screen.findByText("最初评论", { selector: ".timeline-records p" });
    expect(textOf(screen.getByRole("alert"))).not.toContain("可能已经成功");
    expect(input.value).toBe("编辑后的评论");
    expect(read.mock.calls.at(-1)?.[2]?.at).toBeUndefined();
    expect(addComment).toHaveBeenCalledTimes(2);
    expect(
      f.state().timeline.filter((entry) => entry.body === "编辑后的评论"),
    ).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "发表评论" }));
    await waitFor(() => expect(input.value).toBe(""));
    await screen.findByText("编辑后的评论", {
      selector: ".timeline-records p",
    });
    expect(
      screen.getAllByText("最初评论", { selector: ".timeline-records p" }),
    ).toHaveLength(1);
    for (const body of ["最初评论", "编辑后的评论"]) {
      expect(
        f.state().timeline.filter((entry) => entry.body === body),
      ).toHaveLength(1);
      expect(
        f
          .state()
          .events.filter(
            (event) =>
              event.type === "comment_posted" && event.payload.body === body,
          ),
      ).toHaveLength(1);
    }
    const keys = addComment.mock.calls.map((args) => args[3]);
    expect(keys[0]).toMatch(/^[0-9a-f-]{36}$/u);
    expect(keys[1]).toBe(keys[0]);
    expect(keys[2]).not.toBe(keys[0]);
  },
);

test("U10 §8.1: an authenticated fresh Workbench explains its empty project list", async () => {
  await f.close();
  f = await browserFixture({ emptyProjects: true });
  await f.loginBrowser();
  expect(await f.client.projects()).toEqual([]);
  render(<App client={f.client} />);
  expect(
    textOf(await screen.findByText(/还没有项目|暂无项目|没有项目/)),
  ).toMatch(/项目/);
  expect(screen.getByText(/cardigan project create/)).toBeTruthy();
});

test("U11 §8.4: attachments show decision status, fold superseded versions and download active content", async () => {
  await f.loginBrowser();
  const decision = f.command((s, a, p) =>
    requestDecision(
      s,
      a,
      {
        card_id: f.card.id,
        category: "scope_change",
        kind: "choose",
        question: "Approve image direction",
        context: "Choose a design",
        options: [{ key: "yes", description: "Use it", impact: "Proceed" }],
        recommended: "yes",
        affected_cards: [f.card.id],
        affected_work_items: [],
        blocking: false,
        decider: "human",
      },
      p,
    ),
  );
  f.command((s, a, p) =>
    recordDecision(
      s,
      a,
      {
        decision_id: decision.id,
        option: "yes",
        rationale: "Approved",
        raw_quote: "Use it",
      },
      { ...p, human_confirmation: "workbench" },
    ),
  );
  const comment = await f.agentComment("Design attachments");
  const upload = (mime: string, body: string, supersedes?: string) =>
    f.mcp<Attachment>(f.primary.owner, "upload_attachment", {
      card_id: f.card.id,
      file: Buffer.from(body).toString("base64"),
      mime,
      kind: "artifact",
      basis: decision.id,
      attach_to: { kind: "timeline_entry", id: comment.id },
      ...(supersedes ? { supersedes } : {}),
    });
  const old = await upload("image/png", "old design"),
    current = await upload("image/png", "new design", old.id),
    svg = await upload("image/svg+xml", "<svg onload='bad()'></svg>");
  const rows = await f.client.cards(project(), "all");
  expect(
    rows.cards.find((card) => card.id === f.card.id)?.attachment_count,
  ).toBe(3);
  const page = detail();
  await screen.findByText("Design attachments");
  // Inspect the attachment's owning comment, not the separate upload-event
  // thumbnail which now appears before it in the newest-first timeline.
  const commentRow = page.container.querySelector(`[id="entry-${comment.id}"]`);
  if (!commentRow) throw new Error("Missing attachment comment");
  const images = [...commentRow.querySelectorAll("img")];
  expect(
    images.some((i) => i.getAttribute("src")?.endsWith(`/${current.id}`)),
  ).toBe(true);
  expect(
    images.some((i) => i.getAttribute("src")?.endsWith(`/${svg.id}`)),
  ).toBe(false);
  const oldImage = images.find((i) =>
    i.getAttribute("src")?.endsWith(`/${old.id}`),
  );
  expect(oldImage?.closest("details")?.open).toBe(false);
  const currentImage = images.find((i) =>
    i.getAttribute("src")?.endsWith(`/${current.id}`),
  );
  const evidence = currentImage?.closest("li");
  expect(textOf(evidence ?? null)).toContain(decision.id);
  expect(textOf(evidence ?? null)).toMatch(/已拍板|已批|已解决/);
  const download = [...commentRow.querySelectorAll("a")].find((a) =>
    a.getAttribute("href")?.endsWith(`/${svg.id}`),
  );
  expect(download?.textContent).toMatch(/下载/);
});
