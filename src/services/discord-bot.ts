import { AsyncResource } from "node:async_hooks"
import { createDiscordAdapter } from "@chat-adapter/discord"
import { createRedisState } from "@chat-adapter/state-redis"
import {
  HttpClient,
  HttpClientRequest,
  HttpClientResponse
} from "@effect/platform"
import { Chat, type SlashCommandEvent } from "chat"
import { Context, Data, Effect, Layer } from "effect"

import { AppConfig } from "../config"
import type { Contest } from "../domain/contest"
import type { RatingSnapshot, TrackingPlatform } from "../domain/bot-state"
import { ContestDigestService, renderContestLine } from "./contest-digest"
import { ProfileSourceService } from "./profile-sources"
import { StateStoreService } from "./state-store"
import {
  formatDeliveryTime,
  isValidTimeZone,
  parseDeliveryTime,
  computeNextDeliveryAt
} from "../lib/time"
import { formatTrackedProfileSummary, normalizeHandle } from "../lib/tracking"

export class DiscordIntegrationError extends Data.TaggedError("DiscordIntegrationError")<{
  readonly operation: string
  readonly reason: string
  readonly cause?: unknown
}> {}

export interface DiscordBotService {
  readonly handleWebhook: (
    request: Request
  ) => Effect.Effect<Response, DiscordIntegrationError>
  readonly postChannelMessage: (
    guildId: string,
    channelId: string,
    message: string
  ) => Effect.Effect<{ readonly messageId: string | null }, DiscordIntegrationError>
  readonly registerCommands: Effect.Effect<void, DiscordIntegrationError>
}

export const DiscordBotService = Context.GenericTag<DiscordBotService>("DiscordBotService")

interface DiscordInteractionOption {
  readonly name?: string
  readonly value?: string | number | boolean
  readonly options?: ReadonlyArray<DiscordInteractionOption>
}

interface DiscordInteractionRaw {
  readonly guild_id?: string
  readonly channel_id?: string
  readonly token?: string
  readonly channel?: {
    readonly name?: string
    readonly type?: number
    readonly parent_id?: string
  }
  readonly member?: {
    readonly permissions?: string
  }
  readonly data?: {
    readonly options?: ReadonlyArray<DiscordInteractionOption>
  }
}

const ADMINISTRATOR = 0x8n
const MANAGE_CHANNELS = 0x10n

const channelRef = (guildId: string, channelId: string): string => `discord:${guildId}:${channelId}`

const platformLabel = (platform: TrackingPlatform): string =>
  platform === "codeforces" ? "Codeforces" : "AtCoder"

const buildHelpMessage = (defaultTimeZone: string, defaultTime: string): string =>
  [
    "## Contest Digest Bot",
    `> -# Default TZ \`${defaultTimeZone}\`  ·  Time \`${defaultTime}\``,
    "",
    "**Setup**",
    "`/setup`  `/settings`  `/time`  `/timezone`  `/disable`",
    "",
    "**Contests**",
    "`/today`  `/tomorrow`  `/next`  `/lucky`  `/upcoming`  `/test-digest`",
    "",
    "**Tracking**",
    "`/track-add`  `/track-remove`  `/track-list`  `/leaderboard`  `/rating`  `/compare`  `/streak`"
  ].join("\n")

const buildAnnouncementMessage = (
  platform: TrackingPlatform,
  handle: string,
  previous: RatingSnapshot,
  nextRating: number,
  nextRank: string | null,
  profileUrl: string
): string => {
  const oldRating = previous.rating ?? 0
  const delta = nextRating - oldRating
  const rank = nextRank ? `  ·  ${nextRank}` : ""
  return [
    `## ${platformLabel(platform)} — Rating Improved`,
    `> **[${handle}](${profileUrl})**  \`${oldRating}\` → \`${nextRating}\`  *(+${delta})*${rank}`
  ].join("\n")
}

const commandDefinitions = [
  {
    name: "setup",
    description: "Enable or update scheduled contest digests for this channel.",
    options: [
      { type: 3, name: "time", description: "24-hour time like 21:00", required: true },
      { type: 3, name: "timezone", description: "IANA timezone like Asia/Dhaka", required: true }
    ]
  },
  { name: "settings", description: "Show the current channel settings." },
  { name: "disable", description: "Disable scheduled updates in this channel." },
  {
    name: "timezone",
    description: "Update the channel timezone.",
    options: [{ type: 3, name: "value", description: "IANA timezone like Asia/Dhaka", required: true }]
  },
  {
    name: "time",
    description: "Update the channel delivery time.",
    options: [{ type: 3, name: "value", description: "24-hour time like 21:00", required: true }]
  },
  { name: "today", description: "Show contests happening today." },
  { name: "tomorrow", description: "Show tomorrow's digest immediately." },
  {
    name: "upcoming",
    description: "Show upcoming contests for a range of days.",
    options: [{ type: 4, name: "days", description: "Number of days to look ahead (default 7, max 30)", required: false }]
  },
  { name: "test-digest", description: "Preview the scheduled digest for this channel." },
  { name: "next", description: "Show the next upcoming contest." },
  {
    name: "track-add",
    description: "Start tracking a Codeforces or AtCoder handle for this channel.",
    options: [
      {
        type: 3, name: "platform", description: "Competitive programming platform", required: true,
        choices: [{ name: "Codeforces", value: "codeforces" }, { name: "AtCoder", value: "atcoder" }]
      },
      { type: 3, name: "handle", description: "The user handle to track", required: true }
    ]
  },
  {
    name: "track-remove",
    description: "Stop tracking a handle in this channel.",
    options: [
      {
        type: 3, name: "platform", description: "Competitive programming platform", required: true,
        choices: [{ name: "Codeforces", value: "codeforces" }, { name: "AtCoder", value: "atcoder" }]
      },
      { type: 3, name: "handle", description: "The user handle to remove", required: true }
    ]
  },
  { name: "track-list", description: "List tracked handles for this channel." },
  {
    name: "rating",
    description: "Show the current rating snapshot for a user.",
    options: [
      {
        type: 3, name: "platform", description: "Competitive programming platform", required: true,
        choices: [{ name: "Codeforces", value: "codeforces" }, { name: "AtCoder", value: "atcoder" }]
      },
      { type: 3, name: "handle", description: "The user handle to inspect", required: true }
    ]
  },
  {
    name: "compare",
    description: "Compare two users on the same platform.",
    options: [
      {
        type: 3, name: "platform", description: "Competitive programming platform", required: true,
        choices: [{ name: "Codeforces", value: "codeforces" }, { name: "AtCoder", value: "atcoder" }]
      },
      { type: 3, name: "handle_a", description: "First handle", required: true },
      { type: 3, name: "handle_b", description: "Second handle", required: true }
    ]
  },
  {
    name: "streak",
    description: "Show how many improvements the bot has recorded for a tracked user.",
    options: [
      {
        type: 3, name: "platform", description: "Competitive programming platform", required: true,
        choices: [{ name: "Codeforces", value: "codeforces" }, { name: "AtCoder", value: "atcoder" }]
      },
      { type: 3, name: "handle", description: "Tracked handle", required: true }
    ]
  },
  { name: "leaderboard", description: "Show the top 10 rated users in this channel." },
  { name: "lucky", description: "Pick a fun contest from tomorrow's pool." },
  { name: "help", description: "Show command help and setup guidance." }
]

const hasAdminPermissions = (raw: DiscordInteractionRaw): boolean => {
  const permissionValue = raw.member?.permissions
  if (!permissionValue) return false
  const permissions = BigInt(permissionValue)
  return (
    (permissions & ADMINISTRATOR) === ADMINISTRATOR ||
    (permissions & MANAGE_CHANNELS) === MANAGE_CHANNELS
  )
}

const flattenOptions = (
  options: ReadonlyArray<DiscordInteractionOption> | undefined
): Map<string, string> => {
  const values = new Map<string, string>()
  const walk = (items: ReadonlyArray<DiscordInteractionOption> | undefined): void => {
    if (!items) return
    for (const item of items) {
      if (item.name && item.value !== undefined) values.set(item.name, String(item.value))
      if (item.options) walk(item.options)
    }
  }
  walk(options)
  return values
}

const asInteractionRaw = (raw: unknown): DiscordInteractionRaw => raw as DiscordInteractionRaw

const getChannelContext = (raw: DiscordInteractionRaw): {
  readonly guildId: string
  readonly channelId: string
  readonly guildName: string | null
  readonly channelName: string | null
} | null => {
  if (!raw.guild_id || !raw.channel_id) return null
  return {
    guildId: raw.guild_id,
    channelId: raw.channel_id,
    guildName: null,
    channelName: raw.channel?.name ?? null
  }
}

const isUnsupportedChannelType = (raw: DiscordInteractionRaw): boolean => {
  const type = raw.channel?.type
  if (type === undefined) return false
  return type === 11 || type === 12 || type === 15
}

const registerSlashCommands = (
  httpClient: HttpClient.HttpClient,
  token: string,
  applicationId: string
): Effect.Effect<void, DiscordIntegrationError> =>
  HttpClientRequest.put(
    `https://discord.com/api/v10/applications/${applicationId}/commands`
  ).pipe(
    HttpClientRequest.setHeader("Authorization", `Bot ${token}`),
    HttpClientRequest.setHeader("Accept", "application/json"),
    (request) => HttpClientRequest.bodyJson(request, commandDefinitions),
    Effect.mapError(
      (cause) => new DiscordIntegrationError({ operation: "registerCommands", reason: "Failed to build request", cause })
    ),
    Effect.flatMap((request) => httpClient.execute(request)),
    Effect.flatMap(HttpClientResponse.filterStatusOk),
    Effect.asVoid,
    Effect.mapError((cause) =>
      cause instanceof DiscordIntegrationError
        ? cause
        : new DiscordIntegrationError({ operation: "registerCommands", reason: "Failed to register slash commands", cause })
    )
  )

export const DiscordBotServiceLive = Layer.scoped(
  DiscordBotService,
  Effect.gen(function* () {
    const config = yield* AppConfig
    const httpClient = yield* HttpClient.HttpClient
    const store = yield* StateStoreService
    const digestService = yield* ContestDigestService
    const profileService = yield* ProfileSourceService

    const helpMessage = buildHelpMessage(
      config.defaultTimeZone,
      formatDeliveryTime(config.defaultDeliveryHour, config.defaultDeliveryMinute)
    )

    const chat = new Chat({
      userName: config.botUserName,
      adapters: { discord: createDiscordAdapter() },
      state: createRedisState({ url: config.redisUrl, keyPrefix: "contest-bot-chat" })
    })

    // Patch: bind ALS context before async hop.
    // processSlashCommand is called synchronously inside requestContext.run, but
    // handleSlashCommandEvent is async — ALS context is gone by the time it runs.
    // AsyncResource.bind here captures the context while still inside requestContext.run.
    {
      const original = (chat as any).handleSlashCommandEvent.bind(chat)
      ;(chat as any).handleSlashCommandEvent = function (event: unknown, options: unknown) {
        return AsyncResource.bind(() => original(event, options))()
      }
    }

    const getChannelTimeZone = async (channelId: string | undefined): Promise<string> => {
      if (!channelId) return config.defaultTimeZone
      const subscription = await Effect.runPromise(store.getSubscriptionByChannel(channelId))
      return subscription?.timezone ?? config.defaultTimeZone
    }

    const requireAdminChannel = async (
      event: SlashCommandEvent,
      post: (msg: string) => Promise<void>
    ): Promise<{ readonly guildId: string; readonly channelId: string; readonly guildName: string | null; readonly channelName: string | null } | null> => {
      const raw = asInteractionRaw(event.raw)
      const context = getChannelContext(raw)
      if (!context) { await post("⚠️ Use this command inside a Discord server text channel."); return null }
      if (isUnsupportedChannelType(raw)) { await post("⚠️ Run this command in a regular text or announcement channel."); return null }
      if (!hasAdminPermissions(raw)) { await post("⚠️ You need `Manage Channels` or `Administrator` permission for this command."); return null }
      return context
    }

    const onCommand = (
      name: string,
      handler: (event: SlashCommandEvent, post: (msg: string) => Promise<void>) => Promise<void>
    ) => {
      chat.onSlashCommand(name, (event) => {
        const post = async (msg: string) => { await event.channel.post(msg) }
        return (async () => {
          try {
            console.log(`[Command] ${name} | User: ${event.user.userName}`)
            await handler(event, post)
          } catch (error) {
            console.error(`[Command] ${name} failed:`, error)
            try { await post("Error: The command failed to complete.") } catch {}
          }
        })()
      })
    }

    onCommand("/help", async (event, post) => {
      await post(helpMessage)
    })

    onCommand("/setup", async (event, post) => {
      const context = await requireAdminChannel(event, post)
      if (!context) return
      const options = flattenOptions(asInteractionRaw(event.raw).data?.options)
      const time = options.get("time")
      const timezone = options.get("timezone")
      if (!time || !timezone) { await post("Both `time` and `timezone` are required."); return }
      const parsedTime = parseDeliveryTime(time)
      if (!parsedTime) { await post("Use a 24-hour time like `21:00`."); return }
      if (!isValidTimeZone(timezone)) { await post("That timezone is not a valid IANA timezone."); return }
      const subscription = await Effect.runPromise(
        store.upsertSubscription({
          ...context,
          timezone,
          deliveryHour: parsedTime.hour,
          deliveryMinute: parsedTime.minute,
          createdByUserId: event.user.userId
        })
      )
      await post(`**Setup Complete:** Scheduled updates enabled for <#${subscription.channelId}> at \`${formatDeliveryTime(subscription.deliveryHour, subscription.deliveryMinute)}\` (${subscription.timezone}).`)
    })

    onCommand("/settings", async (event, post) => {
      const raw = asInteractionRaw(event.raw)
      const context = getChannelContext(raw)
      if (!context) { await post("Use this command inside a Discord server text channel."); return }
      const [subscription, trackedHandles] = await Promise.all([
        Effect.runPromise(store.getSubscriptionByChannel(context.channelId)),
        Effect.runPromise(store.listTrackedHandlesByChannel(context.channelId))
      ])
      if (!subscription) { await post("This channel is not configured yet. Run `/setup time:<HH:MM> timezone:<IANA zone>`."); return }
      const nextRun = computeNextDeliveryAt(new Date(), subscription.timezone, subscription.deliveryHour, subscription.deliveryMinute)
      await post([
        `## Settings — <#${subscription.channelId}>`,
        `> Status \`${subscription.enabled ? "active" : "disabled"}\`  ·  TZ \`${subscription.timezone}\`  ·  Time \`${formatDeliveryTime(subscription.deliveryHour, subscription.deliveryMinute)}\`  ·  Next <t:${Math.floor(nextRun.getTime() / 1000)}:R>`,
        "",
        `**Tracked Handles** *(${trackedHandles.length})*`,
        "",
        trackedHandles.length === 0
          ? "*none*"
          : trackedHandles.map(t => `> \`${platformLabel(t.platform)}\`  ${t.handle}`).join("\n")
      ].join("\n"))
    })

    onCommand("/disable", async (event, post) => {
      const context = await requireAdminChannel(event, post)
      if (!context) return
      const disabled = await Effect.runPromise(store.disableSubscription(context.channelId))
      await post(disabled ? "**Disabled:** Scheduled updates are now disabled for this channel." : "This channel was not configured yet.")
    })

    onCommand("/timezone", async (event, post) => {
      const context = await requireAdminChannel(event, post)
      if (!context) return
      const timezone = flattenOptions(asInteractionRaw(event.raw).data?.options).get("value")
      if (!timezone || !isValidTimeZone(timezone)) { await post("Provide a valid IANA timezone (e.g., `Asia/Dhaka`)."); return }
      const updated = await Effect.runPromise(store.updateSubscriptionTimeZone(context.channelId, timezone))
      await post(updated ? `**Updated:** Timezone changed to \`${updated.timezone}\`.` : "Run `/setup` first before updating settings.")
    })

    onCommand("/time", async (event, post) => {
      const context = await requireAdminChannel(event, post)
      if (!context) return
      const timeValue = flattenOptions(asInteractionRaw(event.raw).data?.options).get("value")
      const parsedTime = timeValue ? parseDeliveryTime(timeValue) : null
      if (!parsedTime) { await post("Provide a valid 24-hour time like `21:00`."); return }
      const updated = await Effect.runPromise(store.updateSubscriptionDeliveryTime(context.channelId, parsedTime.hour, parsedTime.minute))
      await post(updated ? `**Updated:** Delivery time changed to \`${formatDeliveryTime(updated.deliveryHour, updated.deliveryMinute)}\`.` : "Run `/setup` first before updating settings.")
    })

    onCommand("/today", async (event, post) => {
      const raw = asInteractionRaw(event.raw)
      const timeZone = await getChannelTimeZone(raw.channel_id)
      const digest = await Effect.runPromise(digestService.getDigest("today", timeZone))
      await post(digest.message)
    })

    onCommand("/tomorrow", async (event, post) => {
      const raw = asInteractionRaw(event.raw)
      const timeZone = await getChannelTimeZone(raw.channel_id)
      const digest = await Effect.runPromise(digestService.getDigest("tomorrow", timeZone))
      await post(digest.message)
    })

    onCommand("/upcoming", async (event, post) => {
      const raw = asInteractionRaw(event.raw)
      const options = flattenOptions(raw.data?.options)
      const days = Math.min(Math.max(Number(options.get("days") || "7"), 1), 30)
      const timeZone = await getChannelTimeZone(raw.channel_id)
      const digest = await Effect.runPromise(digestService.getUpcomingRange(days, timeZone))
      await post(digest.message)
    })

    onCommand("/test-digest", async (event, post) => {
      const context = await requireAdminChannel(event, post)
      if (!context) return
      const subscription = await Effect.runPromise(store.getSubscriptionByChannel(context.channelId))
      const timeZone = subscription?.timezone ?? config.defaultTimeZone
      const digest = await Effect.runPromise(digestService.getDigest("tomorrow", timeZone))
      await post(digest.message)
    })

    onCommand("/next", async (event, post) => {
      const raw = asInteractionRaw(event.raw)
      const timeZone = await getChannelTimeZone(raw.channel_id)
      const contest = await Effect.runPromise(digestService.getNextUpcomingContest(timeZone))
      if (!contest) { await post("📭 No upcoming contests found right now."); return }
      await post(["## Next Up", "", renderContestLine(contest, timeZone)].join("\n"))
    })

    onCommand("/lucky", async (event, post) => {
      const raw = asInteractionRaw(event.raw)
      const timeZone = await getChannelTimeZone(raw.channel_id)
      const contest = await Effect.runPromise(digestService.pickLuckyContest(timeZone))
      if (!contest) { await post("🎲 No contest was available for a lucky pick."); return }
      await post(["## Lucky Pick", "> -# bias: contests ≤ 2h", "", renderContestLine(contest, timeZone)].join("\n"))
    })

    onCommand("/track-add", async (event, post) => {
      const context = await requireAdminChannel(event, post)
      if (!context) return
      const options = flattenOptions(asInteractionRaw(event.raw).data?.options)
      const platform = options.get("platform") as TrackingPlatform | undefined
      const handle = options.get("handle")
      if (!platform || !handle) { await post("⚠️ Both `platform` and `handle` are required."); return }
      const profile = await Effect.runPromise(profileService.fetchProfile(platform, handle))
      const trackedHandle = await Effect.runPromise(
        store.addTrackedHandle(context.channelId, platform, profile.handle, normalizeHandle(profile.handle), event.user.userId)
      )
      if (!trackedHandle) { await post("⚠️ Run `/setup` first before adding tracked handles."); return }
      await post(`✅ **Tracking Started:** Now monitoring ${platformLabel(platform)} handle \`${trackedHandle.handle}\` in this channel.`)
    })

    onCommand("/track-remove", async (event, post) => {
      const context = await requireAdminChannel(event, post)
      if (!context) return
      const options = flattenOptions(asInteractionRaw(event.raw).data?.options)
      const platform = options.get("platform") as TrackingPlatform | undefined
      const handle = options.get("handle")
      if (!platform || !handle) { await post("⚠️ Both `platform` and `handle` are required."); return }
      const removed = await Effect.runPromise(store.removeTrackedHandle(context.channelId, platform, normalizeHandle(handle)))
      await post(removed ? `🗑️ **Removed:** Stopped tracking ${platformLabel(platform)} handle \`${handle}\`.` : "⚠️ That handle is not currently tracked in this channel.")
    })

    onCommand("/track-list", async (event, post) => {
      const raw = asInteractionRaw(event.raw)
      const context = getChannelContext(raw)
      if (!context) { await post("⚠️ Use this command inside a Discord server text channel."); return }
      const trackedHandles = await Effect.runPromise(store.listTrackedHandlesByChannel(context.channelId))
      await post(["## Tracked Handles", "", trackedHandles.length === 0 ? "*none*" : trackedHandles.map(t => `> \`${platformLabel(t.platform)}\`  ${t.handle}`).join("\n")].join("\n"))
    })

    onCommand("/leaderboard", async (event, post) => {
      const raw = asInteractionRaw(event.raw)
      const context = getChannelContext(raw)
      if (!context) { await post("⚠️ Use this command inside a Discord server text channel."); return }
      const leaderboard = await Effect.runPromise(store.getLeaderboard(context.channelId))
      if (leaderboard.length === 0) { await post("ℹ️ No rated users tracked in this channel yet."); return }
      await post([
        "## Leaderboard",
        "",
        ...leaderboard.map((entry, i) => {
          const rank = entry.rankLabel ? `  *${entry.rankLabel}*` : ""
          const profileUrl = entry.platform === "codeforces"
            ? `https://codeforces.com/profile/${encodeURIComponent(entry.handle)}`
            : `https://atcoder.jp/users/${encodeURIComponent(entry.handle)}`
          return `> **${i + 1}.** [${entry.handle}](${profileUrl})  \`${platformLabel(entry.platform)}\`  **${entry.rating ?? "Unrated"}**${rank}`
        })
      ].join("\n"))
    })

    onCommand("/rating", async (event, post) => {
      const options = flattenOptions(asInteractionRaw(event.raw).data?.options)
      const platform = options.get("platform") as TrackingPlatform | undefined
      const handle = options.get("handle")
      if (!platform || !handle) { await post("⚠️ Both `platform` and `handle` are required."); return }
      const profile = await Effect.runPromise(profileService.fetchProfile(platform, handle))
      await post([
        `## ${platformLabel(platform)} Rating`,
        `> **[${profile.handle}](${profile.profileUrl})**  \`${profile.rating ?? "Unrated"}\`${profile.rankLabel ? `  *${profile.rankLabel}*` : ""}${profile.maxRating ? `  ·  max \`${profile.maxRating}\`` : ""}`
      ].join("\n"))
    })

    onCommand("/compare", async (event, post) => {
      const options = flattenOptions(asInteractionRaw(event.raw).data?.options)
      const platform = options.get("platform") as TrackingPlatform | undefined
      const handleA = options.get("handle_a")
      const handleB = options.get("handle_b")
      if (!platform || !handleA || !handleB) { await post("⚠️ `platform`, `handle_a`, and `handle_b` are required."); return }
      const [left, right] = await Promise.all([
        Effect.runPromise(profileService.fetchProfile(platform, handleA)),
        Effect.runPromise(profileService.fetchProfile(platform, handleB))
      ])
      const fmt = (p: typeof left) => `> **[${p.handle}](${p.profileUrl})**  \`${p.rating ?? "Unrated"}\`${p.rankLabel ? `  *${p.rankLabel}*` : ""}${p.maxRating ? `  ·  max \`${p.maxRating}\`` : ""}`
      await post([`## ${platformLabel(platform)} Comparison`, "", fmt(left), fmt(right)].join("\n"))
    })

    onCommand("/streak", async (event, post) => {
      const raw = asInteractionRaw(event.raw)
      const context = getChannelContext(raw)
      if (!context) { await post("⚠️ Use this command inside a Discord server text channel."); return }
      const options = flattenOptions(raw.data?.options)
      const platform = options.get("platform") as TrackingPlatform | undefined
      const handle = options.get("handle")
      if (!platform || !handle) { await post("⚠️ Both `platform` and `handle` are required."); return }
      const trackedHandle = await Effect.runPromise(store.getTrackedHandleByChannel(context.channelId, platform, normalizeHandle(handle)))
      if (!trackedHandle) { await post("⚠️ That handle is not tracked in this channel yet."); return }
      const count = await Effect.runPromise(store.countImprovementSnapshots(context.channelId, platform, trackedHandle.handleNormalized))
      await post(`## Streak\n> \`${trackedHandle.handle}\`  **${count}** improvement${count === 1 ? "" : "s"} recorded`)
    })

    const initializedChat = yield* Effect.acquireRelease(
      Effect.tryPromise({
        try: async () => { await chat.initialize(); return chat },
        catch: (cause) => new DiscordIntegrationError({ operation: "initialize", reason: "Failed to initialize Chat SDK", cause })
      }),
      (instance) =>
        Effect.tryPromise({
          try: () => instance.shutdown(),
          catch: (cause) => new DiscordIntegrationError({ operation: "shutdown", reason: "Failed to shut down Chat SDK cleanly", cause })
        }).pipe(Effect.catchAll(() => Effect.void))
    )

    return {
      handleWebhook: (request) =>
        Effect.gen(function* () {
          yield* Effect.logDebug(`Discord webhook received: ${request.method} ${request.url}`)
          const response = yield* Effect.tryPromise({
            try: () => initializedChat.webhooks.discord(request),
            catch: (cause) => new DiscordIntegrationError({ operation: "handleWebhook", reason: "Discord webhook handling failed", cause })
          })
          yield* Effect.logInfo(`Discord webhook processed with status ${response.status}`)
          return response
        }),
      postChannelMessage: (guildId, channelId, message) =>
        Effect.tryPromise({
          try: async () => {
            const sent = await initializedChat.channel(channelRef(guildId, channelId)).post(message)
            return { messageId: sent.id || null }
          },
          catch: (cause) => new DiscordIntegrationError({ operation: "postChannelMessage", reason: "Failed to post a message to Discord", cause })
        }),
      registerCommands: registerSlashCommands(httpClient, config.discordBotToken, config.discordApplicationId)
    }
  })
)
