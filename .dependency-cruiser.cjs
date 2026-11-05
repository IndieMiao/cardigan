// Lower layers first: a layer may only depend on the layers below it.
// `host` sits between the packages and the apps: it is the one place that
// orchestrates a start, so the CLI and the server share it instead of copying.
const layers = [
  ["domain"],
  ["store", "router", "mcp-server", "git-service", "roles"],
  ["runtime-herdr", "git-transport"],
  ["host"],
  ["server", "web", "cli"],
];
const APP_LAYER = layers.length - 1;
const location = (name, layer) =>
  `${layer === APP_LAYER ? "apps" : "packages"}/${name}`;

module.exports = {
  forbidden: [
    {
      name: "no-unresolved",
      severity: "error",
      from: {},
      to: { couldNotResolve: true },
    },
    {
      name: "no-circular",
      severity: "error",
      from: {},
      to: { circular: true },
    },
    ...layers.flatMap((names, layer) =>
      names.map((name) => {
        const forbidden = layers.flatMap((targets, targetLayer) =>
          targetLayer < layer
            ? []
            : targets
                .filter((target) => target !== name)
                .flatMap((target) => [
                  location(target, targetLayer),
                  `@cardigan/${target}`,
                ]),
        );
        return {
          name: `${name}-only-lower-layers`,
          severity: "error",
          from: { path: `^${location(name, layer)}/` },
          to: { path: `^(${forbidden.join("|")})(/|$)` },
        };
      }),
    ),
    {
      name: "domain-no-external-packages",
      severity: "error",
      from: { path: "^packages/domain/" },
      to: {
        dependencyTypes: [
          "npm",
          "npm-dev",
          "npm-optional",
          "npm-peer",
          "npm-no-pkg",
          "npm-unknown",
        ],
      },
    },
    {
      name: "domain-no-node-io",
      severity: "error",
      from: { path: "^packages/domain/" },
      to: {
        dependencyTypes: ["core"],
        path: "^(node:)?(child_process|cluster|console|dgram|dns|fs|http|http2|https|inspector|module|net|os|process|readline|repl|sqlite|stream|tls|trace_events|tty|v8|worker_threads)(/|$)",
      },
    },
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    exclude: { path: "\\.test\\.[jt]sx?$" },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: "tsconfig.base.json" },
    enhancedResolveOptions: {
      exportsFields: ["exports"],
      conditionNames: ["import", "node", "default"],
    },
  },
};
