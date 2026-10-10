// What every screen needs from the shell, passed down once instead of through each component.
import { createContext, useContext } from "react";
import type { Connection } from "./api.ts";
import type { State } from "./state.ts";

export interface Ctx {
  s: State;
  conn: Connection | null;
  notify: (message: string) => void;
  /** Opens the timeline drawer for one request. */
  openTrace: (traceId: string, messageId?: string) => void;
}

export const AppContext = createContext<Ctx | null>(null);

export function useApp(): Ctx {
  const c = useContext(AppContext);
  if (!c) throw new Error("AppContext missing");
  return c;
}
