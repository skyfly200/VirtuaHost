// The hub's just-in-time logic and its Postgres store are plain CommonJS files (the hub server runs them as they are). This is the one place
// the site imports them, so a bundler pulls them in and the rest of lib/hub stays typed and testable (tests pass their own copies in).
// @ts-expect-error CommonJS without type declarations
import jit from "../../chips-voice/hub/jit.js";
// @ts-expect-error CommonJS without type declarations
import pgStore from "../../chips-voice/hub/pg-store.js";

export const createJit = jit.createJit as HubModules["createJit"];
export const createPgStore = pgStore.createPgStore as HubModules["createPgStore"];

/* eslint-disable @typescript-eslint/no-explicit-any */
export interface HubStore { data: Record<string, any>; save(): void; flush(): Promise<void>; load(): Promise<Record<string, any>> }
export interface HubJit {
  dueSlots(): { id: string }[];
  sweepQueue(): void;
  gc(): void;
  processSlot(slot: any, opts?: any): Promise<{ state?: string; reason?: string } | null>;
}
export interface HubModules {
  createJit(deps: Record<string, any>): HubJit;
  createPgStore(db: unknown, defaults?: unknown, opts?: { debounceMs?: number }): HubStore;
}
