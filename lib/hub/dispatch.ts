import { createHmac, timingSafeEqual } from "node:crypto";

// The scheduled tick hands each due slot to a background function by calling its URL. That URL is public, so every call carries a
// signature only this site can make (HMAC of the slot id with HUB_DISPATCH_KEY, or SESSION_SECRET when that is not set).
const secret = () => process.env.HUB_DISPATCH_KEY || process.env.SESSION_SECRET || "";

export const dispatchConfigured = (): boolean => secret().length >= 16;

export function signSlot(slotId: string): string {
  return createHmac("sha256", secret()).update(`hub-slot:${slotId}`).digest("hex");
}

export function verifySlot(slotId: string, sig: unknown): boolean {
  if (!dispatchConfigured() || typeof sig !== "string" || !slotId) return false;
  const a = Buffer.from(sig);
  const b = Buffer.from(signSlot(slotId));
  return a.length === b.length && timingSafeEqual(a, b);
}
