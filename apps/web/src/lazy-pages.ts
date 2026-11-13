import { lazy } from "react";

// Keep the landing board in the entry; fetch other views only when opened.
export const ActivityPage = lazy(() =>
  import("./views/ActivityPage.js").then((m) => ({ default: m.ActivityPage })),
);
export const CardDetailPage = lazy(() =>
  import("./views/CardDetailPage.js").then((m) => ({
    default: m.CardDetailPage,
  })),
);
export const DecisionHistoryPage = lazy(() =>
  import("./views/DecisionHistoryPage.js").then((m) => ({
    default: m.DecisionHistoryPage,
  })),
);
export const ExecutionPage = lazy(() =>
  import("./views/ExecutionPage.js").then((m) => ({
    default: m.ExecutionPage,
  })),
);
export const NeedsYouPage = lazy(() =>
  import("./views/NeedsYouPage.js").then((m) => ({ default: m.NeedsYouPage })),
);
export const SettingsPage = lazy(() =>
  import("./views/SettingsPage.js").then((m) => ({ default: m.SettingsPage })),
);
export const SnapshotPage = lazy(() =>
  import("./views/SnapshotPage.js").then((m) => ({ default: m.SnapshotPage })),
);
