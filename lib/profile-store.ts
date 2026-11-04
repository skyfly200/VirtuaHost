import { getStore } from "@netlify/blobs";

// What a person has added to their sign-in beyond the password: an email address and linked Google / GitHub logins. Kept apart from
// users/<name>.json so it works the same for people in the database and for bootstrap admins from LOGIN_USERS (who have no record there).
// Blobs store "auth": profiles/<name>.json holds the profile; identities/<provider>/<id>.json maps a Google/GitHub id back to the username.
export const IDENTITY_PROVIDERS = ["google", "github"] as const;
export type IdentityProvider = (typeof IDENTITY_PROVIDERS)[number];

export interface Identity { id: string; label: string; email?: string; linkedAt: string }
export interface Profile { email?: string; identities: Partial<Record<IdentityProvider, Identity>> }

const store = () => getStore("auth");
const profileKey = (name: string) => `profiles/${name.trim().toLowerCase()}.json`;
const emailKey = (email: string) => `emails/${encodeURIComponent(email.trim().toLowerCase())}.json`;
const idKey = (provider: IdentityProvider, id: string) => `identities/${provider}/${encodeURIComponent(id)}.json`;

export const validEmail = (v: unknown): v is string => typeof v === "string" && v.length <= 120 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim());

export async function getProfile(username: string): Promise<Profile> {
  const p = (await store().get(profileKey(username), { type: "json" })) as Profile | null;
  return { ...(p?.email ? { email: p.email } : {}), identities: p?.identities ?? {} };
}

/** The username that uses this email address (emails are unique across accounts), or null. */
export async function usernameForEmail(email: string): Promise<string | null> {
  const row = (await store().get(emailKey(email), { type: "json" })) as { username?: string } | null;
  return row?.username ?? null;
}

export async function saveProfile(username: string, profile: Profile): Promise<void> {
  const before = (await store().get(profileKey(username), { type: "json" })) as Profile | null;
  if (before?.email && before.email !== profile.email) await store().delete(emailKey(before.email));
  if (profile.email) await store().setJSON(emailKey(profile.email), { username: username.trim().toLowerCase() });
  await store().setJSON(profileKey(username), profile);
}

/** The username a Google/GitHub id is linked to, or null. */
export async function usernameForIdentity(provider: IdentityProvider, id: string): Promise<string | null> {
  const row = (await store().get(idKey(provider, id), { type: "json" })) as { username?: string } | null;
  return row?.username ?? null;
}

/** Links an identity. Returns the other username when that Google/GitHub account already belongs to someone else. */
export async function linkIdentity(username: string, provider: IdentityProvider, identity: Omit<Identity, "linkedAt">): Promise<{ taken: string } | null> {
  const owner = await usernameForIdentity(provider, identity.id);
  if (owner && owner !== username.trim().toLowerCase()) return { taken: owner };
  const profile = await getProfile(username);
  const old = profile.identities[provider];
  if (old && old.id !== identity.id) await store().delete(idKey(provider, old.id));
  profile.identities[provider] = { ...identity, linkedAt: new Date().toISOString() };
  await store().setJSON(idKey(provider, identity.id), { username: username.trim().toLowerCase() });
  await saveProfile(username, profile);
  return null;
}

export async function unlinkIdentity(username: string, provider: IdentityProvider): Promise<boolean> {
  const profile = await getProfile(username);
  const found = profile.identities[provider];
  if (!found) return false;
  await store().delete(idKey(provider, found.id));
  delete profile.identities[provider];
  await saveProfile(username, profile);
  return true;
}
