# Multi-Tenant Discord Contest Bot

## Summary
- Build a Bun-first TypeScript Discord bot that can be installed in any server and configured from chat, without asking the user for raw Discord IDs.
- Use `Elysia` for the Discord interactions HTTP surface, `Effect` for orchestration, scheduling, config, and upstream HTTP access, and Redis for persistent bot state.
- Run a scheduler tick every 10 minutes. Each tick checks which configured channels are due for a digest and which tracked users need rating/rank-change announcements.
- Support daily contest digests for Codeforces and AtCoder, plus per-channel tracking of competitive programming users with congratulation messages on improvement.

## Product Behavior
- Install flow:
  - A server admin adds the bot to a Discord server.
  - In any text channel, they run `/setup` to enable updates for that channel.
  - The bot reads `guild_id` and `channel_id` from the slash-command context, so the user never needs to know what those IDs are.
- Delivery model:
  - Each channel can have its own timezone and daily delivery time.
  - The scheduler runs every 10 minutes and sends the digest once per local day per subscribed channel.
  - The digest contains contests happening on the next calendar day in that channel’s configured timezone.
- Tracking model:
  - A channel can track multiple Codeforces and AtCoder handles.
  - On each scheduler tick, the bot refreshes tracked-user state.
  - If a tracked user’s rating or rank improves compared with the latest stored snapshot, the bot posts a congratulation message in that channel and records that event to avoid duplicates.

## Implementation Changes
- Runtime and app shape:
  - Keep `bun` as both runtime and package manager.
  - Keep `Elysia` for the HTTP endpoint that receives Discord interactions.
  - Keep `Effect` for typed services, scheduler loop, config loading, DB access, and upstream fetches.
  - Uses Redis for all persistent state (subscriptions, tracking, snapshots).
- Discord integration:
  - Register global slash commands at startup.
  - Use slash-command context as the source of truth for current guild and channel.
  - Gate mutating admin commands like `/setup`, `/disable`, and `/timezone` to users with channel-management or admin permissions.
- Contest ingestion:
  - Keep Codeforces on the official `contest.list` API.
  - Keep AtCoder on the official contests page parser unless a better official machine-readable feed is introduced later.
  - Normalize all contests into one internal shape shared by digests, previews, and reminders.
- Scheduler:
  - Fixed 10-minute polling loop.
  - On each tick:
    - Refresh or reuse cached contest data.
    - Query active channel subscriptions that are due to receive today’s next-day digest.
    - Send the digest and mark that local-date delivery as completed in Redis.
    - Refresh tracked handles and announce improvements when detected.
- Persistence:
  - Redis is the system of record for subscriptions, tracked handles, rating snapshots, and sent events.
  - In-memory state is not used for persistence.
  - Do not rely on Discord IDs from environment variables except the application credentials.

## Commands
- Core configuration:
  - `/setup time:<HH:MM> timezone:<IANA zone>`
    - Enable or update digest delivery for the current channel.
  - `/settings`
    - Show current channel configuration, next scheduled delivery, and tracked handles.
  - `/disable`
    - Disable digest delivery for the current channel.
  - `/timezone value:<IANA zone>`
    - Update only the channel timezone.
  - `/time value:<HH:MM>`
    - Update only the channel delivery time.
- Digest and preview:
  - `/today`
    - Show contests remaining today in the channel’s timezone.
  - `/tomorrow`
    - Show the next-day digest immediately.
  - `/upcoming days:<number>`
    - Show upcoming contests for a range of days (default 7).
  - `/test-digest`
    - Force a preview post for the current channel without changing scheduler state.
  - `/next`
    - Show the next upcoming contest across all supported platforms.
- Tracking:
  - `/track-add platform:<codeforces|atcoder> handle:<string>`
    - Start tracking a user in the current channel.
  - `/track-remove platform:<codeforces|atcoder> handle:<string>`
    - Stop tracking a user in the current channel.
  - `/track-list`
    - List all tracked handles for the current channel.
  - `/rating platform:<codeforces|atcoder> handle:<string>`
    - Show the latest known rating/rank snapshot for a user.
- Useful and fun extras for v1:
  - `/compare platform:<...> handle_a:<...> handle_b:<...>`
    - Show a quick side-by-side comparison using latest stored rating/rank data.
  - `/streak platform:<...> handle:<...>`
    - Show how many upward rating changes have been recorded for that user by this bot.
  - `/lucky`
    - Return one recommended upcoming contest from the next-day pool, biased toward shorter or beginner-friendlier contests when possible.

## Data Model
- Redis key groups
  - `subscriptions:index`
  - `subscription:{channel_id}`
  - `delivery:{channel_id}:{target_date_key}`
  - `tracked:channel:{channel_id}`
  - `tracked:meta:{channel_id}:{platform}:{handle_normalized}`
  - `snapshot:latest:{tracked_handle_id}`
  - `snapshot:history:{tracked_handle_id}`
  - `snapshot:improvement-count:{tracked_handle_id}`
  - `announcement:{tracked_handle_id}:{rating_snapshot_id}`

## Public Interfaces
- Required environment variables:
  - `DISCORD_BOT_TOKEN`
  - `DISCORD_PUBLIC_KEY`
  - `DISCORD_APPLICATION_ID`
  - `REDIS_URL`
- Optional environment variables:
  - `BOT_USER_NAME`
  - `PORT`
  - `SCHEDULER_POLL_MINUTES` default `10`
  - `CONTEST_CACHE_TTL_SECONDS`
- Internal services:
  - `ContestCatalogService` for fetching and caching normalized contest data.
  - `ContestDigestService` for per-timezone digest assembly and preview rendering.
  - `StateStoreService` for Redis-backed channel settings, tracked handles, rating snapshots, and dedupe state.
  - `DiscordBotService` for slash commands, webhook handling, and outbound posts.
  - `SchedulerService` for the fixed-interval polling loop.

## Scheduling Rules
- Poll every 10 minutes.
- For each active subscription, determine the channel-local current date and time.
- A subscription is due when:
  - current local hour equals `delivery_hour`
  - current local minute is within the current poll window for `delivery_minute`
  - no `digest_deliveries` row exists yet for that subscription and the target local next-day date
- Use Redis delivery keys as the dedupe source of truth instead of in-memory state.
- Tracking checks also run every 10 minutes but announce only when a newly captured snapshot is strictly better than the previously stored one.

## Test Plan
- Unit tests:
  - timezone-based due-subscription calculation for the 10-minute polling window
  - digest filtering for “today”, “tomorrow”, and empty-state channels
  - Codeforces contest normalization
  - AtCoder contest-page parsing
  - improvement detection for tracked users
- Integration tests:
  - `/setup` creates or updates a channel subscription from Discord interaction context
  - `/disable` disables a subscription without deleting history
  - scheduled tick sends exactly one digest per channel per target local date
  - tracked-user improvement posts exactly one congratulation message per new better snapshot
  - Redis state keys enforce uniqueness and dedupe correctly

## Assumptions
- “Guild” means Discord server and “channel” means Discord text channel, but users should not need to enter those IDs manually.
- Daily contest updates are configured per channel, not per individual Discord user.
- Redis is required; in-memory state is not acceptable for production behavior.
- Slash commands are the primary control surface; free-form AI chat remains out of scope unless explicitly added later.
- Codeforces tracking can use official profile or API data.
- AtCoder tracking may require parsing official user pages if no official structured API is available for the needed fields.
