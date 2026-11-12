import { createRoot } from "react-dom/client";
import { AVATAR_LIBRARY } from "../../../packages/domain/src/avatar-library.js";
import { App } from "../src/App.js";
import { fakeClient } from "../src/testing/fixtures.js";
import "@fontsource-variable/inter";
import "@fontsource-variable/noto-sans-sc";
import "@fontsource-variable/jetbrains-mono";
import "../src/styles.css";

const client = fakeClient({
  roles: async () => ({
    project_id: "p-1",
    roles: [
      {
        role_id: "coder",
        display_name: "开发工程师",
        kind: "produce",
        status: "active",
        version: 1,
        harness: "codex",
        launch_profile_ref: "fixture",
      },
    ],
    default_roles: ["coder", "reviewer", "pm"],
    harnesses: ["codex", "pi", "claude-code"],
    allowlists: { produce: [], verify: [], standing: [] },
  }),
  employeeOptions: async () => ({
    library: AVATAR_LIBRARY.map(([id, name, source]) => ({
      id,
      name,
      source,
      avatar: `/avatars/v1/${id}/head-128.webp`,
      occupied_by:
        id === "zhu-bajie"
          ? { id: "E-1", name: "八戒", status: "active" }
          : id === "sha-seng"
            ? { id: "E-2", name: "悟净", status: "inactive" }
            : null,
    })),
    roles: [{ role_id: "coder", display_name: "开发工程师" }],
  }),
});
const root = document.getElementById("root");
if (!root) throw new Error("Missing screenshot fixture root");
createRoot(root).render(<App client={client} />);
