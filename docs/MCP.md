# MCP: let an AI agent run the stations

VirtuaHost has a **Model Context Protocol (MCP) server** so an AI agent (Claude, Sylvia's assistant, any MCP client) can manage stations directly: look at them, set their location, write and speak drops, schedule them, check weather alerts, and, with a person's say-so, put things on air. It sits on the same API the web UI uses, so the **same sign-in, roles, ownership and limits apply**.

(The Chips Voice server in `chips-voice/` has its own MCP server for the stream itself: now playing, skip, say on air, effects. See [SETUP.md](SETUP.md#d-chat-and-mcp). This one is for the **site**: stations, clips, schedules, alerts, and, through the hub, several live stations.)

## Connect

- **URL:** `https://<your-site>/api/mcp` (Streamable HTTP, stateless, JSON responses).
- **Credential:** `Authorization: Bearer <token>` or `x-api-key: <key>`. Use either a **session token** (from `POST /api/login`, expires after `SESSION_HOURS`) or the site's `ACCESS_KEY`.
- **Who the agent acts as** is decided by the credential. A person's login acts as that person (their role, their clips, their limits). `ACCESS_KEY` acts as an **admin with no limits**, so for a long-running agent make a **dedicated login** (Users tab) with the least role that does the job; a regular user can write and schedule but cannot create stations or touch the hub.
- Claude Code: `claude mcp add --transport http virtuahost https://<site>/api/mcp --header "Authorization: Bearer <token>"`.
- Other clients: point them at the URL with that header (clients that only do stdio can use a bridge such as `mcp-remote`).
- `MCP_READ_ONLY=true` (site environment) registers only the read tools.

## Tools

Three kinds, shown in each tool's annotations (`readOnlyHint`, `destructiveHint`) and in its description.

| Kind | Meaning |
|---|---|
| **read** | looks only |
| **write** | changes the site (saves a station, a clip, a schedule) but **nothing reaches listeners** |
| **air** | **PUBLIC STREAM** or permanent (send to the station, delete, run a schedule). Needs `confirm: true`, which the agent may only set **after the person says yes**; without it the tool refuses and says why |

| Tool | Kind | Does |
|---|---|---|
| `whoami` | read | your role, limits and usage |
| `list_stations` | read | station profiles; with `lat`/`lon`, ranked by distance with whether each covers the point |
| `station_summary` | read | what the site holds for a station |
| `find_place` | read | town or city by name -> coordinates, state, time zone |
| `active_alerts` | read | US NWS alerts at a station's location |
| `list_personas`, `list_models`, `list_clips`, `clip_info`, `list_schedules`, `list_queue` | read | the obvious lookups (models carry price tier and filter label) |
| `template_variables`, `render_template` | read | the `{{placeholders}}` with today's values; try a text |
| `estimate_cost` | read | tokens and dollars before spending |
| `hub_stations`, `hub_alerts`, `hub_alert_check` | read | the hub's live stations and alert watches (admins; needs the site connected to the hub); `hub_alert_check` is a dry run |
| `create_station`, `update_station` | write | station profiles (admins). `update_station` replaces the profile: read, change, send back |
| `write_line` | write | AI writes a drop, text only |
| `make_clip` | write | speak and **save** a clip (not sent anywhere) |
| `create_schedule`, `set_schedule_enabled` | write (`air` when sending to air or turning on) | timetables; `send: air` needs `confirm` |
| `hub_set_alert_watch` | write (`broadcast` needs `confirm`) | add a weather-alert watch to the hub |
| `send_clip_to_station` | **air** | queue a clip; `play: true` puts it on air |
| `run_schedule_now`, `delete_clip`, `delete_schedule` | **air** | run a schedule now; delete permanently |

Every result is JSON text; failures come back as a tool error with the API's own message and status ("Clip not found (404)", "Only an admin can do that (403)"), so the agent can correct itself.

## Safety model

1. **The credential is the permission.** The MCP layer has no powers of its own: each tool is a normal API call as the caller. A regular user's agent cannot create stations, read other people's clips or exceed that person's limits.
2. **Confirm before the public stream or deleting.** Server-enforced (`confirm: true`), plus the `destructiveHint` annotation so clients can show their own prompt, plus the server `instructions` that tell the agent to ask first.
3. **Spend is visible.** `estimate_cost` before expensive steps; AI-using tools count against the caller's limits like the UI does (an agent using a person's own AI key does not).
4. **Read-only mode** for an agent that should only observe.
5. **Everything is logged** (tool name and kind, never arguments or secrets).

## Recommended: a dedicated agent login (and what is missing)

Today an agent uses a normal login or `ACCESS_KEY`. A short-lived session token is inconvenient for a long-running agent, and `ACCESS_KEY` is too powerful. **Planned:** per-user **API tokens** (created in the account card, shown once, revocable, optionally read-only or limited to chosen stations), so an agent gets its own credential that is neither a password nor the master key. Until then, give the agent its own login and rotate its password; set `MCP_READ_ONLY` while it is being trusted.

## Planned tools (spec)

| Tool | For |
|---|---|
| `hub_broadcast` (air) | the same moment on several live stations, optionally at a time |
| `hub_group_skip`, `hub_group_volume`, `hub_set_playlist` (air) | group controls |
| `hub_sync_host` (write) | copy virtual-host settings between stations |
| `set_station_location` (write) | find a place and set the station's location, time zone and radius in one step |
| `stations_for_event` (read) | rank stations for an event by coverage and population ([COVERAGE.md](COVERAGE.md)) |
| `create_alert_watch_for_station` (write) | a hub watch from a station's location or coverage |
| `list_users`, `set_user_limits` (admin) | user management by an administrator agent |
| A `resources` and `prompts` surface | station profiles as resources; "plan a week of drops for station X" style prompts |

## Verified, and not

Verified: the protocol handling and every tool through the real handlers with mocked storage (`test/functions/mcp.test.ts`): authentication, initialize, notifications, batches, tool listing with annotations, read-only mode, the confirm guard, error mapping and the hub proxy. **Not verified:** a live MCP client (Claude Desktop, Claude Code); the message shapes follow the MCP 2025-03-26 specification, so connect one and run `tools/list` before relying on it.
