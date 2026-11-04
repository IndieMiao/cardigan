// Lower layers first. A layer may only depend on layers above it in this list.
// mcp-server and router sit above store because they serve the domain through
// the store (development plan §20.2 lists them as peers of store; M1.5 needs
// mcp-server -> store for token verification and read queries).
const layers = [
  ["domain"],
  ["store", "git-service", "roles"],
  ["router", "mcp-server"],
  ["runtime-herdr", "git-transport"],
  ["server", "web", "cli"],
];
const appNames = new Set(["server", "web", "cli"]);
const location = (name) =>
  `${appNames.has(name) ? "apps" : "packages"}/${name}`;

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
          from: { path: `^${location(name)}/` },
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
