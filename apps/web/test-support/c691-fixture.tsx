import { createRoot } from "react-dom/client";
import { AttachmentRefBody } from "../src/components/AttachmentRefBody.js";
import { StatusTag } from "../src/components/Foundation.js";
import { IdTag } from "../src/components/IdTag.js";
import {
  CardPeek,
  CardPeekActions,
  CardPeekFact,
  CardPeekFacts,
  CardPeekHeading,
} from "../src/components/layout/CardPeekLayout.js";
import { SettingsHelp } from "../src/components/layout/SettingsLayout.js";
import { Button } from "../src/components/ui/button.js";
import * as Popover from "../src/components/ui/popover.js";
import { attachmentChip } from "../src/markdown.js";
import "@fontsource-variable/inter";
import "@fontsource-variable/noto-sans-sc";
import "@fontsource-variable/jetbrains-mono";
import "../src/components/ui/theme.css";

// C-691: the tip kinds that are not on the card page board, rendered from
// their shared components with synthetic data. No backend, no production data;
// the thumbnail is a tiny SVG served by the capture script's Vite middleware.
const chip = attachmentChip({
  id: "attachment-142",
  name: "第一关截图.png",
  kind: "image",
  mime: "image/png",
  size: 312_000,
  href: "/__c691/thumb.svg",
  thumbnail: "/__c691/thumb.svg",
  preview: "/__c691/thumb.svg",
});

function Gallery() {
  return (
    <main className="ui-workspace" data-c691-gallery="">
      <p data-c691="id">
        编号提示 <IdTag id="W-2215" detail="前端开发 · 薛宝钗" />
      </p>
      <p data-c691="help">
        设置说明
        <SettingsHelp label="合并确认说明">
          开启后由系统按门禁合并，并在时间线知会人。
        </SettingsHelp>
      </p>
      <Popover.Popover>
        <p data-c691="peek">
          依赖节点
          <Popover.PopoverTrigger asChild>
            <Button size="sm">C-12</Button>
          </Popover.PopoverTrigger>
        </p>
        <CardPeek aria-label="卡片 C-12">
          <CardPeekHeading>C-12 统一提示框的边框和阴影</CardPeekHeading>
          <CardPeekFacts>
            <CardPeekFact label="状态">
              <StatusTag status="in_progress" />
            </CardPeekFact>
            <CardPeekFact label="关系">前置</CardPeekFact>
          </CardPeekFacts>
          <CardPeekActions>
            <Button size="sm">打开卡片</Button>
          </CardPeekActions>
        </CardPeek>
      </Popover.Popover>
      <AttachmentRefBody
        className="ui-prose"
        html={`<p data-c691="attachment">截图见 ${chip}</p>`}
      />
    </main>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("Missing root");
createRoot(root).render(<Gallery />);
