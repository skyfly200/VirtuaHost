import type { Config } from "@netlify/functions";
import { createLogger } from "../../lib/log.js";
import { hubDb } from "../../lib/hub/db.js";
import { netlifyAudioBlobs } from "../../lib/hub/audio.js";
import { dispatchConfigured, signSlot } from "../../lib/hub/dispatch.js";
import { createJit, createPgStore } from "../../lib/hub/jit-cjs.js";
import { runTick } from "../../lib/hub/runner.js";

const log = createLogger("hub-tick");

// Every minute: expire clips nobody picked up, tidy up, and start a background run (hub-slot-background) for each slot whose time has come.
// Does nothing until DATABASE_URL (the hub's Neon database) is set.
export default async () => {
  const db = hubDb();
  if (!db) return;
  const base = process.env.URL ?? process.env.SITE_URL ?? "";
  if (!dispatchConfigured() || !base) {
    log.warn("not dispatching: set HUB_DISPATCH_KEY (or SESSION_SECRET) and make sure the site URL is known");
    return;
  }
  try {
    const result = await runTick(
      { db, blobs: netlifyAudioBlobs(), createJit, createPgStore },
      async (slotId) => {
        const res = await fetch(new URL("/.netlify/functions/hub-slot-background", base), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ slotId, sig: signSlot(slotId) }),
        });
        if (!res.ok) throw new Error(`background run not accepted: ${res.status}`);
      },
    );
    if (result.due.length || result.failed.length) log.info("tick", { due: result.due.length, dispatched: result.dispatched.length, failed: result.failed.length });
  } catch (err) {
    log.error("tick failed", { err });
  }
};

export const config: Config = {
  schedule: "* * * * *",
};
