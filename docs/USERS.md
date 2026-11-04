# Users, roles and limits

People who can sign in are kept in the site's own storage (Netlify Blobs, store `auth`), so adding someone never needs a redeploy or an environment variable.

## First admin

Set `SESSION_SECRET` (32+ characters) and put one admin in `LOGIN_USERS`:

```
npm run hash-password -- alice      # prints alice:scrypt....  -> LOGIN_USERS
```

Sign in as that admin, open the **Users** tab and add everyone else. People in `LOGIN_USERS` are always admins and can only be changed in the site settings.

## Roles

| | admin | user |
|---|---|---|
| Generate, Flier, Personas drafts, Schedules, Library | yes | yes |
| See | everything | their own clips/personas/schedules plus the station's shared ones |
| Change shared things (made by an admin or the access key) | yes | no (duplicate a persona to make your own) |
| Stations, virtual host settings, Control tab, Users tab | yes | read-only / no |
| Limits | none | yes |

Records made by an admin or by `ACCESS_KEY` have no owner and are shared with everyone. Records made by a regular user are theirs alone (admins can see and manage them).

## Limits

Set per person in **Users -> Limits**, with site-wide defaults from `QUOTA_DAILY_AI`, `QUOTA_MONTHLY_AI`, `QUOTA_MAX_CLIPS`, `QUOTA_MAX_SCHEDULES`. Empty = use the default; no default = no limit; 0 blocks it.

- **AI requests** count every writing, speaking, flier or persona-draft request (previews included, failed provider calls included). Days and months are UTC. Over the limit the API answers `429`.
- **Clips / schedules** count what the person currently owns.
- Scheduled runs spend the **owner's** AI requests, and stop while the owner is disabled or deleted.

Counters are read-then-write on Blobs, so two simultaneous requests can both slip under a limit by one. That is fine for cost control.

## Their own AI keys

Every person can save their own OpenRouter, Gemini or ElevenLabs key (the card at the top of the page). Their requests then use it, are billed to them, and do not count toward their limits. Admins can also save a key per station. Details: [KEYS.md](KEYS.md).

## Moving to a database later

Everything that reads or writes users is in `lib/user-store.ts`; usage counters are in `lib/quota.ts`. Replace those two files' storage calls (for example with Turso or D1 over HTTP) and nothing else changes.

## Email and linked Google / GitHub logins

Account settings has a separate card for each concern: email, sign-in methods, password, and one key card each for OpenRouter, Google (Gemini) and ElevenLabs.
- **Email** (`PATCH /api/users/me { email, currentPassword }`, `""` removes it): unique across accounts, stored in `profiles/<name>.json` of the `auth` Blobs store (`lib/profile-store.ts`), so bootstrap admins from `LOGIN_USERS` can have one too.
- **Linked logins** (`lib/oauth.ts`, `lib/handlers/oauth.ts`, `/api/oauth/:provider/{start,callback}`): set `GOOGLE_CLIENT_ID/SECRET` and/or `GITHUB_CLIENT_ID/SECRET` (redirect URI `https://<site>/api/oauth/<provider>/callback`). A person links a login while signed in; "Sign in with Google/GitHub" then signs in that account. These logins never create accounts, and one Google/GitHub identity belongs to one account. Not verified against live Google or GitHub.
