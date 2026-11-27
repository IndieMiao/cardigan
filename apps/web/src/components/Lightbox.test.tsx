// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { Lightbox } from "./Lightbox.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

if (globalThis.ResizeObserver === undefined)
  Object.defineProperty(globalThis, "ResizeObserver", {
    configurable: true,
    value: class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  });

// The zoom viewport measures 800×600; jsdom lays nothing out otherwise.
beforeEach(() => {
  const size = (value: number) =>
    function (this: HTMLElement) {
      return this.tagName === "DIV" && this.hasAttribute("data-lightbox-blank")
        ? value
        : 0;
    };
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(
    size(800),
  );
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(
    size(600),
  );
});

function pointer(
  target: EventTarget,
  type: string,
  init: MouseEventInit & {
    pointerId?: number;
    pointerType?: string;
    isPrimary?: boolean;
  } = {},
) {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    button: 0,
    buttons: type === "pointerup" ? 0 : 1,
    ...init,
  });
  Object.defineProperties(event, {
    pointerId: { value: init.pointerId ?? 1 },
    pointerType: { value: init.pointerType ?? "mouse" },
    isPrimary: { value: init.isPrimary ?? true },
  });
  fireEvent(target, event);
}

/** A press and release without movement, then its click. */
function tap(target: Element, x: number, y: number) {
  pointer(target, "pointerdown", { clientX: x, clientY: y });
  pointer(target, "pointerup", { clientX: x, clientY: y });
  fireEvent.click(target, { clientX: x, clientY: y, detail: 1 });
}

function Harness({ onClose }: { onClose?: () => void }) {
  const [open, setOpen] = useState(true);
  const [index, setIndex] = useState(0);
  return (
    <Lightbox
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) onClose?.();
      }}
      index={index}
      onIndexChange={setIndex}
      images={[
        { src: "/tall.png", alt: "竖长对比图", caption: "对比" },
        { src: "/wide.png", alt: "超宽图", caption: "宽" },
      ]}
    />
  );
}

function loaded(name: string, width: number, height: number) {
  const image = screen.getByRole("img", { name });
  Object.defineProperties(image, {
    naturalWidth: { configurable: true, value: width },
    naturalHeight: { configurable: true, value: height },
  });
  fireEvent.load(image);
  return image;
}

const zoomValue = () =>
  screen.getByRole("toolbar", { name: "缩放" }).querySelector("span")
    ?.textContent;

function setup() {
  const onClose = vi.fn();
  render(<Harness onClose={onClose} />);
  const image = loaded("竖长对比图", 720, 2880);
  const viewport = image.parentElement as HTMLElement;
  viewport.setPointerCapture = vi.fn();
  return { image, viewport, onClose };
}

test("a tall image opens fitted; buttons zoom, fit and show 100%", () => {
  const { image } = setup();
  expect(zoomValue()).toBe("21%");
  expect(image.style.height).toBe("600px");
  expect(image.style.transform).toBe("translate(325px, 0px)");
  expect(
    screen.getByRole("button", { name: "缩小" }).getAttribute("aria-disabled"),
  ).toBe("true");
  fireEvent.click(screen.getByRole("button", { name: "放大" }));
  expect(zoomValue()).toBe("26%");
  fireEvent.click(screen.getByRole("button", { name: "原始大小 100%" }));
  expect(zoomValue()).toBe("100%");
  expect(image.style.width).toBe("720px");
  fireEvent.click(screen.getByRole("button", { name: "缩小" }));
  expect(zoomValue()).toBe("80%");
  fireEvent.click(screen.getByRole("button", { name: "适应窗口" }));
  expect(zoomValue()).toBe("21%");
  expect(screen.getByRole("dialog")).toBeTruthy();
});

test("the wheel zooms around the pointer and keys zoom too", () => {
  const { viewport } = setup();
  fireEvent.wheel(viewport, { deltaY: -200, clientX: 400, clientY: 0 });
  expect(zoomValue()).toBe(
    `${Math.round((600 / 2880) * Math.exp(0.4) * 100)}%`,
  );
  const dialog = screen.getByRole("dialog");
  fireEvent.keyDown(dialog, { key: "0" });
  expect(zoomValue()).toBe("21%");
  fireEvent.keyDown(dialog, { key: "+" });
  expect(zoomValue()).toBe("26%");
  fireEvent.keyDown(dialog, { key: "-" });
  expect(zoomValue()).toBe("21%");
});

test("dragging pans within the image and the drag's click does not close", () => {
  const { image, viewport, onClose } = setup();
  fireEvent.click(screen.getByRole("button", { name: "原始大小 100%" }));
  expect(image.style.transform).toBe("translate(40px, -1140px)");
  expect(viewport.hasAttribute("data-pannable")).toBe(true);
  pointer(image, "pointerdown", { clientX: 400, clientY: 300 });
  pointer(image, "pointermove", { clientX: 400, clientY: 250 });
  expect(viewport.hasAttribute("data-dragging")).toBe(true);
  expect(viewport.setPointerCapture).toHaveBeenCalledWith(1);
  expect(image.style.transform).toBe("translate(40px, -1190px)");
  // Far past the top edge: the image stops at its own bottom edge.
  pointer(viewport, "pointermove", { clientX: 900, clientY: -5000 });
  expect(image.style.transform).toBe("translate(40px, -2280px)");
  pointer(viewport, "pointerup", { clientX: 900, clientY: -5000 });
  fireEvent.click(viewport, { detail: 1 });
  expect(viewport.hasAttribute("data-dragging")).toBe(false);
  expect(onClose).not.toHaveBeenCalled();
  expect(screen.getByRole("dialog")).toBeTruthy();
});

test("a click on the image keeps the preview; one on blank space closes it", async () => {
  const { image, viewport, onClose } = setup();
  tap(image, 400, 300);
  expect(screen.getByRole("dialog")).toBeTruthy();
  tap(viewport, 20, 20);
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(onClose).toHaveBeenCalledTimes(1);
});

test("a click on the caption's blank space or the backdrop closes the preview", async () => {
  render(<Harness />);
  const caption = screen.getByText("对比").parentElement as HTMLElement;
  fireEvent.click(screen.getByText("对比"));
  expect(screen.getByRole("dialog")).toBeTruthy();
  fireEvent.click(caption);
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
});

test("double click toggles fit and 100%; the next image starts fitted again", () => {
  const { image } = setup();
  tap(image, 400, 300);
  tap(image, 400, 300);
  expect(zoomValue()).toBe("100%");
  tap(image, 400, 300);
  tap(image, 400, 300);
  expect(zoomValue()).toBe("21%");
  fireEvent.click(screen.getByRole("button", { name: "原始大小 100%" }));
  fireEvent.click(screen.getByRole("button", { name: "下一张" }));
  expect(zoomValue()).toBe("—");
  const wide = loaded("超宽图", 4000, 500);
  expect(zoomValue()).toBe("20%");
  expect(wide.style.transform).toBe("translate(0px, 250px)");
});

test("two fingers pinch-zoom; lifting them does not close", () => {
  const { image, viewport, onClose } = setup();
  const touch = { pointerType: "touch" };
  pointer(image, "pointerdown", {
    ...touch,
    pointerId: 1,
    clientX: 350,
    clientY: 300,
  });
  pointer(image, "pointerdown", {
    ...touch,
    pointerId: 2,
    isPrimary: false,
    clientX: 450,
    clientY: 300,
  });
  pointer(viewport, "pointermove", {
    ...touch,
    pointerId: 2,
    isPrimary: false,
    clientX: 750,
    clientY: 300,
  });
  // Finger distance 100px → 400px: four times the fitted scale.
  expect(zoomValue()).toBe(`${Math.round((600 / 2880) * 4 * 100)}%`);
  act(() => {
    pointer(viewport, "pointerup", {
      ...touch,
      pointerId: 2,
      isPrimary: false,
    });
    pointer(viewport, "pointerup", { ...touch, pointerId: 1 });
  });
  fireEvent.click(viewport, { detail: 1 });
  expect(onClose).not.toHaveBeenCalled();
});

test("a drag without its click does not swallow a later blank click", async () => {
  const { image, viewport } = setup();
  pointer(image, "pointerdown", { clientX: 400, clientY: 300 });
  pointer(image, "pointermove", { clientX: 400, clientY: 200 });
  pointer(viewport, "pointerup", { clientX: 400, clientY: 200 });
  const later = new MouseEvent("click", { bubbles: true, detail: 1 });
  Object.defineProperty(later, "timeStamp", {
    value: new MouseEvent("click").timeStamp + 2000,
  });
  fireEvent(viewport, later);
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
});
