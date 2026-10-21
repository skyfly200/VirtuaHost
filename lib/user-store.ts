import { getStore } from "@netlify/blobs";

// People who can sign in, kept in Netlify Blobs (store "auth", key users/<name>.json). Everything that touches users goes
// through this file, so moving to a real database later means changing only these functions.
export type Role = "admin" | "user";

/** Limits for one person. A missing field means "use the site default" (QUOTA_* variables, lib/quota.ts), which is unlimited when unset. */
export interface Quota {
  dailyAi?: number;        // AI requests (writing, speaking, flier, persona drafts) per UTC day
  monthlyAi?: number;      // the same, per UTC month
  maxClips?: number;       // clips saved at one time
  maxSchedules?: number;   // schedules at one time
}

export interface User {
  username: string;            // lowercase; also the id other records use as their owner
  passwordHash: string;        // scrypt, see lib/passwords.ts
  role: Role;
  disabled?: boolean;
  quota?: Quota;
  createdAt: string;
  updatedAt: string;
  lastLoginAt?: string;
}

export const USERNAME = /^[A-Za-z0-9_.@-]{1,40}$/;
export const MIN_PASSWORD_LENGTH = 10;

const store = () => getStore("auth");
export const normalizeUsername = (name: string): string => name.trim().toLowerCase();
const key = (name: string) => `users/${normalizeUsername(name)}.json`;

export async function getUser(username: string): Promise<User | null> {
  if (!USERNAME.test(username.trim())) return null;
  return ((await store().get(key(username), { type: "json" })) as User | null) ?? null;
}

export async function listUsers(): Promise<User[]> {
  const { blobs } = await store().list({ prefix: "users/" });
  const all = (await Promise.all(blobs.map(({ key: k }) => store().get(k, { type: "json" }) as Promise<User | null>))).filter((u): u is User => Boolean(u));
  return all.sort((a, b) => a.username.localeCompare(b.username));
}

export async function saveUser(user: User): Promise<void> {
  await store().setJSON(key(user.username), { ...user, username: normalizeUsername(user.username), updatedAt: new Date().toISOString() });
}

export async function deleteUser(username: string): Promise<void> {
  await store().delete(key(username));
}

/** What the API and UI may see of a user: never the hash. */
export const publicUser = (u: User) => ({
  username: u.username, role: u.role, disabled: Boolean(u.disabled), quota: u.quota ?? {}, createdAt: u.createdAt, lastLoginAt: u.lastLoginAt ?? null, source: "database" as const,
});
