// How a saved clip reaches the station. Two ways, chosen by configuration:
//   STATION_MODE=queue        put it in the queue for the station daemon to collect (recommended: nothing to expose)
//   STATION_URL + INGEST token push it straight to a Chips Voice server's /ingest (lib/handoff.ts)
// Never throws: the clip is already saved, so a station problem is reported, not raised.
import { handoffConfigured, handoffDefaults, pushToStation, type FxSetting, type HandoffResult } from "./handoff.js";
import { enqueue } from "./queue-store.js";

export const queueMode = (): boolean => process.env.STATION_MODE?.trim().toLowerCase() === "queue";
export const stationConfigured = (): boolean => queueMode() || handoffConfigured();

export interface SendOptions {
  clipId: string;
  audio: Buffer;
  mimeType: string;
  title: string;
  play?: boolean;
  preempt?: boolean;
  fx?: FxSetting;
}

export async function sendToStation(options: SendOptions): Promise<HandoffResult & { queued?: boolean; queueId?: string }> {
  const defaults = handoffDefaults();
  const play = options.play ?? defaults.play;
  const preempt = options.preempt ?? defaults.preempt;
  const fx = options.fx ?? defaults.fx;
  if (queueMode()) {
    try {
      const item = await enqueue({ clipId: options.clipId, title: options.title, play, preempt, ...(fx ? { fx } : {}) });
      return { sent: true, queued: true, queueId: item.id };
    } catch (err) {
      return { sent: false, error: `Could not queue the clip: ${(err as Error).message}` };
    }
  }
  return pushToStation(options.audio, { contentType: options.mimeType, title: options.title, text: options.title, play, preempt, fx });
}
