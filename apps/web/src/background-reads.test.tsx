// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { CapacityProvider } from "./components/Capacity.js";
import { cardDetail, fakeClient } from "./testing/fixtures.js";
import { CardDetailPage } from "./views/CardDetailPage.js";
import { ExecutionPage } from "./views/ExecutionPage.js";

// C-775: pages driven by project activity follow the card list: a background
// tab reads nothing, and showing it again reads once.

let hidden = false;
afterEach(() => {
  cleanup();
  hidden = false;
  vi.restoreAllMocks();
});
const setHidden = async (next: boolean) => {
  await act(async () => {
    hidden = next;
    document.dispatchEvent(new Event("visibilitychange"));
  });
};
const settle = () => act(async () => {});

test.each([
  {
    name: "card detail",
    method: "card" as const,
    reply: async () => cardDetail(),
    page: (client: ReturnType<typeof fakeClient>, revision: number) => (
      <CardDetailPage
        client={client}
        projectId="p-1"
        cardId="C-1"
        revision={revision}
      />
    ),
  },
  {
    name: "execution view",
    method: "execution" as const,
    reply: async () => ({ assignments: [], runs: [], machines: [] }),
    page: (client: ReturnType<typeof fakeClient>, revision: number) => (
      <ExecutionPage client={client} projectId="p-1" revision={revision} />
    ),
  },
  {
    name: "capacity",
    method: "executionCapacity" as const,
    reply: async () => ({
      agents: [],
      merge_checks: [],
      merge_config_invalid: false,
    }),
    page: (client: ReturnType<typeof fakeClient>, revision: number) => (
      <CapacityProvider
        client={client}
        projectId="p-1"
        revision={revision}
        canEdit={false}
      >
        <span>内容</span>
      </CapacityProvider>
    ),
  },
])(
  "C-775: the $name pauses while hidden and reads once when shown",
  async ({ method, reply, page }) => {
    vi.spyOn(document, "hidden", "get").mockImplementation(() => hidden);
    hidden = true;
    const read = vi.fn(reply);
    const client = fakeClient({ [method]: read });
    // Opened in a background tab: nothing is read yet.
    const { rerender } = render(page(client, 0));
    await settle();
    expect(read).not.toHaveBeenCalled();
    await setHidden(false);
    await waitFor(() => expect(read).toHaveBeenCalledTimes(1));
    await settle();
    // Project activity while hidden is held back ...
    await setHidden(true);
    rerender(page(client, 1));
    rerender(page(client, 2));
    rerender(page(client, 3));
    await settle();
    expect(read).toHaveBeenCalledTimes(1);
    // ... and caught up with a single read when the tab shows again.
    await setHidden(false);
    await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
    await settle();
    expect(read).toHaveBeenCalledTimes(2);
    // Visible again: activity reads as before.
    rerender(page(client, 4));
    await waitFor(() => expect(read).toHaveBeenCalledTimes(3));
  },
);

test("C-775: the card detail keeps what it showed while the tab is hidden", async () => {
  vi.spyOn(document, "hidden", "get").mockImplementation(() => hidden);
  const client = fakeClient({ card: async () => cardDetail() });
  render(<CardDetailPage client={client} projectId="p-1" cardId="C-1" />);
  const title = cardDetail().card.title;
  expect((await screen.findAllByText(title)).length).toBeGreaterThan(0);
  await setHidden(true);
  expect(screen.getAllByText(title).length).toBeGreaterThan(0);
  expect(screen.queryByText("正在加载卡片 C-1…")).toBeNull();
});
