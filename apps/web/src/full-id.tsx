import { qualifyId } from "@cardigan/domain";
import { createContext, type ReactNode, useContext } from "react";

/**
 * C-674: pages read across projects (Needs You) show full numbers
 * (`SEN-C-34`). Project pages keep the short form: outside a provider,
 * `useFullId` returns the id unchanged.
 */
const FullIdCode = createContext<string | undefined>(undefined);

export function FullIdProvider({
  code,
  children,
}: {
  code: string | null | undefined;
  children: ReactNode;
}) {
  return (
    <FullIdCode.Provider value={code ?? undefined}>
      {children}
    </FullIdCode.Provider>
  );
}

export function useFullId(id: string): string {
  return qualifyId(useContext(FullIdCode), id);
}
