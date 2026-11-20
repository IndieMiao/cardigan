import type { LaunchConfig } from "@cardigan/roles";

/** Choices must describe a generation the host actually accepted, not the files it last attempted. */
export function selectableLaunchConfig({
  config,
  secrets,
}: {
  config: LaunchConfig;
  secrets: Readonly<Record<string, string>>;
}): LaunchConfig {
  const privateValues = Object.values(secrets).filter(Boolean);
  return {
    ...config,
    profiles: Object.fromEntries(
      Object.entries(config.profiles).filter(
        ([name, profile]) =>
          !!profile.model?.trim() &&
          !privateValues.some((value) => name.includes(value)),
      ),
    ),
  };
}
