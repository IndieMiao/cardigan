import { useState } from "react";
import { createRoot } from "react-dom/client";
import { CapacityProvider } from "../src/components/Capacity.js";
import { CardsViewSwitch } from "../src/components/CardsViewSwitch.js";
import { FilterSelect } from "../src/components/FilterSelect.js";
import {
  EmptyState,
  IdTag,
  PageTitle,
  StatusTag,
} from "../src/components/Foundation.js";
import { PageToolbar } from "../src/components/PageToolbar.js";
import { RefreshGroup } from "../src/components/RefreshGroup.js";
import { Button } from "../src/components/ui/button.js";
import { SearchInput } from "../src/components/ui/input.js";
import { fakeClient } from "../src/testing/fixtures.js";
import "@fontsource-variable/inter";
import "@fontsource-variable/noto-sans-sc";
import "@fontsource-variable/jetbrains-mono";
import "../src/components/ui/theme.css";

function StyleReference() {
  const [value, setValue] = useState("");
  const [view, setView] = useState<"board" | "list">("board");
  const [interval, setInterval] = useState(30000);
  return (
    <main className="ui-app-content" data-style-reference>
      <section className="ui-workspace">
        <PageTitle title="样式参考" />
        <PageToolbar
          fields={[
            {
              key: "status",
              label: "状态",
              render: () => (
                <FilterSelect
                  label="状态"
                  value={value}
                  options={[{ value: "review", label: "审核中" }]}
                  onChange={setValue}
                />
              ),
            },
            {
              key: "q",
              label: "搜索",
              grow: true,
              render: () => (
                <SearchInput
                  aria-label="搜索标题或编号"
                  placeholder="搜索标题或编号"
                />
              ),
            },
          ]}
          values={{ status: value }}
          onChange={(v) => setValue(v.status ?? "")}
        >
          <RefreshGroup
            interval={interval}
            onIntervalChange={setInterval}
            pending={false}
            onRefresh={() => {}}
          />
          <CardsViewSwitch value={view} onChange={setView} />
        </PageToolbar>
        <h2>刷新中</h2>
        <RefreshGroup
          interval={0}
          onIntervalChange={setInterval}
          pending
          onRefresh={() => {}}
        />
        <h2>控件状态</h2>
        <div>
          <Button>默认</Button> <Button disabled>不可用</Button>{" "}
          <FilterSelect
            label="状态"
            value="review"
            options={[{ value: "review", label: "审核中" }]}
            onChange={() => {}}
          />
        </div>
        <h2>状态与编号</h2>
        <div>
          {[
            "todo",
            "in_progress",
            "review",
            "awaiting_merge",
            "backlog",
            "cancelled",
            "done",
          ].map((status) => (
            <StatusTag key={status} status={status} />
          ))}
        </div>
        <div>
          {["C-1", "W-1", "A-1", "R-1", "D-1", "V-1", "Q-1", "MB-1"].map(
            (id) => (
              <IdTag key={id} id={id} />
            ),
          )}
        </div>
        <h2>空状态</h2>
        <EmptyState>没有卡片</EmptyState>
      </section>
    </main>
  );
}
const root = document.getElementById("root");
if (!root) throw new Error("Missing root");
createRoot(root).render(
  <CapacityProvider
    client={fakeClient()}
    projectId="p-1"
    revision={0}
    canEdit={false}
  >
    <StyleReference />
  </CapacityProvider>,
);
