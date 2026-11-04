import { createLogger } from "../../lib/log.js";
import { hubDb } from "../../lib/hub/db.js";
import { netlifyAudioBlobs } from "../../lib/hub/audio.js";
import { verifySlot } from "../../lib/hub/dispatch.js";
import { createJit, createPgStore } from "../../lib/hub/jit-cjs.js";
import { runSlot } from "../../lib/hub/runner.js";

const log = createLogger("hub-slot");

// A background function (the name ends in -background, so it may run for up to 15 minutes and answers 202 at once). Started by hub-tick with a
// signed body; anything else is ignored. Writes and speaks one slot's line using the site itself (HUB_SITE_KEY is a scoped service key).
export default async (req: Request) => {
  let slotId = "";
  try {
    const body = (await req.json()) as { slotId?: unknown; sig?: unknown };
    slotId = typeof body.slotId === "string" ? body.slotId : "";
    if (!verifySlot(slotId, body.sig)) return;
  } catch {
    return;
  }
  const db = hubDb();
  if (!db) return;
  try {
    const out = await runSlot(
      {
        db, blobs: netlifyAudioBlobs(), createJit, createPgStore,
        siteUrl: process.env.URL ?? process.env.SITE_URL ?? "", siteKey: process.env.HUB_SITE_KEY ?? process.env.SITE_KEY ?? "",
      },
      slotId,
    );
    log.info("slot run", { slotId, ...out });
  } catch (err) {
    log.error("slot run failed", { err, slotId });
  }
};
