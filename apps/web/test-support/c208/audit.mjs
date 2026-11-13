import { readFile, writeFile } from "node:fs/promises";

const p = JSON.parse(
  await readFile(new URL("./palette.json", import.meta.url), "utf8"),
);
const rgb = (hex) =>
  hex
    .slice(1)
    .match(/../g)
    .map((v) => parseInt(v, 16) / 255);
const luminance = (values) =>
  values.reduce(
    (s, v, i) =>
      s +
      [0.2126, 0.7152, 0.0722][i] *
        (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4),
    0,
  );
const contrast = (a, b) => {
  const [lo, hi] = [luminance(a), luminance(b)].sort((a, b) => a - b);
  return (hi + 0.05) / (lo + 0.05);
};
const mix = (fg, bg, ratio) =>
  rgb(fg).map((v, i) => ratio * v + (1 - ratio) * rgb(bg)[i]);
const surfaces = ["--bg", "--surface", "--surface-muted"];
const report = [];
const check = (name, fg, backgrounds, target) => {
  const ratios = backgrounds.map((bg) =>
    contrast(rgb(fg), Array.isArray(bg) ? bg : rgb(bg)),
  );
  if (Math.min(...ratios) < target)
    throw Error(`${name} fails ${target}:1: ${ratios}`);
  report.push({
    name,
    fg,
    ratios: ratios.map((r) => r.toFixed(2)),
    minimum: Math.min(...ratios).toFixed(2),
    target,
  });
};
for (const [name, fg] of Object.entries(p.after)) {
  if (
    (name.startsWith("--status-") && name !== "--status-cutout") ||
    name.startsWith("--priority-") ||
    ["--text", "--text-muted", "--accent", "--danger"].includes(name)
  ) {
    check(
      name,
      fg,
      [
        ...surfaces.map((s) => p.after[s]),
        mix(fg, p.after["--timeline-card"], 0.12),
      ],
      4.5,
    );
  }
}
check(
  "input boundary",
  p.after["--control-border"],
  surfaces.map((s) => p.after[s]),
  3,
);
check("button text", p.after["--accent-contrast"], [p.after["--accent"]], 4.5);
check(
  "tooltip text",
  p.after["--tooltip-text"],
  [p.after["--tooltip-bg"]],
  4.5,
);
check(
  "success / error cutout",
  p.after["--status-cutout"],
  [p.after["--status-done"], p.after["--danger"]],
  3,
);
for (const [kind, , fg, bg] of p.labels) {
  check(`id ${kind}`, fg, [bg, ...surfaces.map((s) => p.after[s])], 4.5);
  check(`id focus ${kind}`, p.after["--accent"], [bg], 3);
}
const md =
  "# C-208 / C-204 对比度计算\n\n按 WCAG sRGB 相对亮度计算，未四舍五入的比值用于判定。状态/强调/优先级列依次为页面 #181818、面板 #222222、次级/时间线 #2c2c2c、12% 当前色与时间线混合底。编号标签列依次为标签底、页面、面板、次级底。\n\n| 用途/变量 | 前景 | 各背景对比度 | 最低 | 门槛 |\n|---|---|---|---|---|\n" +
  report
    .map(
      (r) =>
        `| ${r.name} | ${r.fg} | ${r.ratios.join(" / ")} | ${r.minimum}:1 | ${r.target}:1 |`,
    )
    .join("\n") +
  "\n";
await writeFile(
  new URL("../../../../docs/design/c208/contrast.md", import.meta.url),
  md,
);
console.log(
  `${report.length} groups passed; labels min ${Math.min(...report.filter((r) => r.name.startsWith("id ") && !r.name.startsWith("id focus ")).map((r) => Number(r.minimum)))}:1`,
);
