import { useState } from "react";
import { createRoot } from "react-dom/client";
import { Drawer } from "../src/components/Drawer.js";
import { Lightbox } from "../src/components/Lightbox.js";
import {
  cardDetail,
  fakeClient,
  timelineEntry,
} from "../src/testing/fixtures.js";
import { CardDetailPage } from "../src/views/CardDetailPage.js";
import "@fontsource-variable/inter";
import "@fontsource-variable/noto-sans-sc";
import "@fontsource-variable/jetbrains-mono";
import "../src/styles.css";

const client = fakeClient({
  card: async () =>
    cardDetail({
      attachments: [],
      timeline: [
        timelineEntry({
          body: "已完成宽屏与窄屏布局核对，保留卡片详情、审核记录和返回焦点。",
        }),
      ],
    }),
});
function Preview() {
  const [image, setImage] = useState(false),
    [index, setIndex] = useState(0);
  return (
    <Drawer open onOpenChange={() => {}} title="C-1 准备发布">
      <CardDetailPage client={client} projectId="p-1" cardId="C-1" inDrawer />
      <Lightbox
        open={image}
        onOpenChange={setImage}
        index={index}
        onIndexChange={setIndex}
        trigger={<button type="button">打开验收图片</button>}
        images={[
          {
            src: "/avatars/v1/qingwen/head-64.webp",
            alt: "界面验收示例",
            caption: "亮暗主题与控件对齐验收",
          },
          { src: "/avatars/v1/miaoyu/head-64.webp", alt: "第二张验收示例" },
        ]}
      />
    </Drawer>
  );
}
const root = document.getElementById("root");
if (root) createRoot(root).render(<Preview />);
