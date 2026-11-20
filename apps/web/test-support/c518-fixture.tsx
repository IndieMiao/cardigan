import { createRoot } from "react-dom/client";
import { App } from "../src/App.js";
import { fakeClient, NOW } from "../src/testing/fixtures.js";
import { launchSettingsFixture } from "../src/testing/launch-settings-fixture.js";
import "@fontsource-variable/inter";
import "@fontsource-variable/noto-sans-sc";
import "@fontsource-variable/jetbrains-mono";
import "../src/components/ui/theme.css";
import { settingsPanels } from "./settings-panels-data.js";

// C-518: synthetic launch settings (4 profiles, 3 providers, 5 references) and
// the existing synthetic settings panels; no backend, live data or credentials.
// `?models=empty|error|pending` selects the read state.
Date.now = () => new Date(NOW).getTime();
const state = new URLSearchParams(location.search).get("models");
const client = fakeClient({
  ...settingsPanels,
  launchSettings: async () => {
    if (state === "pending") return new Promise(() => {});
    if (state === "error") throw new Error("合成失败：启动配置读取失败");
    if (state === "empty")
      return { version: "0".repeat(64), profiles: [], providers: [] };
    return launchSettingsFixture;
  },
});
const root = document.getElementById("root");
if (!root) throw new Error("Missing screenshot fixture root");
createRoot(root).render(<App client={client} />);
