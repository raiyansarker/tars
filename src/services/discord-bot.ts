import { AsyncResource } from "node:async_hooks"
import { createDiscordAdapter } from "@chat-adapter/discord"
import { createIoRedisState } from "@chat-adapter/state-ioredis"
import {
  HttpClient,
  HttpClientRequest,
  HttpClientResponse
} from "@effect/platform"
import { Chat, type SlashCommandEvent } from "chat"
import { Context, Data, Effect, Layer } from "effect"

import { AppConfig } from "../config"
import type { Contest } from "../domain/contest"
import type { TrackingPlatform } from "../domain/bot-state"
import { ContestDigestService, renderContestLine } from "./contest-digest"
import { ProfileSourceError, ProfileSourceService } from "./profile-sources"
import { StateStoreService } from "./state-store"
import { buildTrackingAnnouncement } from "../lib/announcements"
import { generateMotivationalQuote, generateShameExcuse } from "./no"
import { fetchRandomProblem } from "../lib/codeforces"
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
  readonly startGateway: Effect.Effect<never, DiscordIntegrationError>
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
  platform === "codeforces" ? "codeforces" : "atcoder"

const profileUrl = (platform: TrackingPlatform, handle: string): string =>
  platform === "codeforces"
    ? `https://codeforces.com/profile/${encodeURIComponent(handle)}`
    : `https://atcoder.jp/users/${encodeURIComponent(handle)}`

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
  { name: "random", description: "Get a random Codeforces problem suited to your rating." },
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
  applicationId: string,
  isDev = false
): Effect.Effect<void, DiscordIntegrationError> => {
  const commands = isDev
    ? [...commandDefinitions, { name: "simulate", description: "[DEV] Simulate bot events in this channel." }]
    : commandDefinitions
  return HttpClientRequest.put(
    `https://discord.com/api/v10/applications/${applicationId}/commands`
  ).pipe(
    HttpClientRequest.setHeader("Authorization", `Bot ${token}`),
    HttpClientRequest.setHeader("Accept", "application/json"),
    (request) => HttpClientRequest.bodyJson(request, commands),
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
}

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

    const fetchUsername = async (userId: string): Promise<string> => {
      try {
        const res = await fetch(`https://discord.com/api/v10/users/${userId}`, {
          headers: { Authorization: `Bot ${config.discordBotToken}` }
        })
        if (!res.ok) return userId
        const data = await res.json() as { username?: string; global_name?: string }
        return data.global_name ?? data.username ?? userId
      } catch {
        return userId
      }
    }

    const renderTrackedByUser = async (handles: ReadonlyArray<import("../domain/bot-state").TrackedHandle>): Promise<string> => {
      const grouped = new Map<string, typeof handles[number][]>()
      for (const h of handles) {
        const group = grouped.get(h.createdByUserId) ?? []
        group.push(h)
        grouped.set(h.createdByUserId, group)
      }
      const sections = await Promise.all(
        [...grouped.entries()].map(async ([userId, hs]) => {
          const name = await fetchUsername(userId)
          return `**${name}**\n` + hs.map(h => `  [${h.handle}](<${profileUrl(h.platform, h.handle)}>)  ${platformLabel(h.platform)}`).join("\n")
        })
      )
      return sections.join("\n\n")
    }

    const discordAdapter = createDiscordAdapter()
    const chat = new Chat({
      userName: config.botUserName,
      adapters: { discord: discordAdapter },
      state: createIoRedisState({
        url: config.redisUrl,
        keyPrefix: "tars-chat",
        logger: { ...console, child: () => ({ ...console, child: () => console as any }) } as any
      })
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
      if (!context) { await post("Use this command inside a Discord server text channel."); return null }
      if (isUnsupportedChannelType(raw)) { await post("Run this command in a regular text or announcement channel."); return null }
      if (!hasAdminPermissions(raw)) { await post("You need `Manage Channels` or `Administrator` permission for this command."); return null }
      return context
    }

    const onCommand = (
      name: string,
      handler: (event: SlashCommandEvent, post: (msg: string) => Promise<void>) => Promise<void>
    ) => {
      chat.onSlashCommand(name, (event) => {
        const post = async (msg: string) => { await event.channel.post(msg) }
        return (async () => {
          const start = Date.now()
          try {
            await Effect.runPromise(Effect.logInfo(`[cmd] ${name}  user=${event.user.userName}`))
            await handler(event, post)
            await Effect.runPromise(Effect.logDebug(`[cmd] ${name}  done  ${Date.now() - start}ms`))
          } catch (error) {
            await Effect.runPromise(Effect.logError(`[cmd] ${name}  failed  ${error instanceof Error ? error.message : String(error)}`))
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
          ? "none"
          : await renderTrackedByUser(trackedHandles)
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
      if (!contest) { await post("No upcoming contests found right now."); return }
      await post(["## Next Up", "", renderContestLine(contest, timeZone)].join("\n"))
    })

    onCommand("/lucky", async (event, post) => {
      const raw = asInteractionRaw(event.raw)
      const timeZone = await getChannelTimeZone(raw.channel_id)
      const contest = await Effect.runPromise(digestService.pickLuckyContest(timeZone))
      if (!contest) { await post("No contest was available for a lucky pick."); return }
      await post(["## Lucky Pick", "> -# bias: contests under 2h", "", renderContestLine(contest, timeZone)].join("\n"))
    })

    onCommand("/random", async (event, post) => {
      const raw = asInteractionRaw(event.raw)
      const context = getChannelContext(raw)
      if (!context) { await post("⚠️ Use this command inside a Discord server text channel."); return }

      const handles = await Effect.runPromise(store.listTrackedHandlesByChannel(context.channelId))
      const cfHandle = handles.find(
        (h) => h.platform === "codeforces" && h.createdByUserId === event.user.userId
      )
      if (!cfHandle) {
        await post("⚠️ You don't have a Codeforces handle tracked in this channel. Use `/track-add` first.")
        return
      }

      const profile = await Effect.runPromise(
        profileService.fetchProfile("codeforces", cfHandle.handle).pipe(
          Effect.catchAll(() => Effect.succeed(null))
        )
      )
      const rating = profile?.rating ?? 800
      const problem = await Effect.runPromise(
        fetchRandomProblem(rating).pipe(Effect.provideService(HttpClient.HttpClient, httpClient))
      )

      if (!problem) { await post(`No problems found in the ${rating}–${rating + 200} range. Try again later.`); return }

      const tags = problem.tags.length > 0 ? `\n> -# tags: ${problem.tags.join(", ")}` : ""
      await post([
        `## [${problem.name}](<${problem.url}>)`,
        `> Rating: \`${problem.rating}\`  ·  For: \`${cfHandle.handle}\``,
        tags
      ].filter(Boolean).join("\n"))
    })

    onCommand("/track-add", async (event, post) => {
      const context = await requireAdminChannel(event, post)
      if (!context) return
      const options = flattenOptions(asInteractionRaw(event.raw).data?.options)
      const platform = options.get("platform") as TrackingPlatform | undefined
      const handle = options.get("handle")
      if (!platform || !handle) { await post("Both `platform` and `handle` are required."); return }
      const profileResult = await Effect.runPromise(
        profileService.fetchProfile(platform, handle).pipe(Effect.either)
      )
      if (profileResult._tag === "Left") {
        const err = profileResult.left
        await post(`Could not find \`${handle}\` on ${platformLabel(platform)}. Check the handle and try again.`)
        return
      }
      const profile = profileResult.right
      const trackedHandle = await Effect.runPromise(
        store.addTrackedHandle(context.channelId, platform, profile.handle, normalizeHandle(profile.handle), event.user.userId)
      )
      if (!trackedHandle) { await post("Run `/setup` first before adding tracked handles."); return }
      await post(`**Tracking Started:** Now monitoring ${platformLabel(platform)} handle \`${trackedHandle.handle}\` in this channel.`)
    })

    onCommand("/track-remove", async (event, post) => {
      const context = await requireAdminChannel(event, post)
      if (!context) return
      const options = flattenOptions(asInteractionRaw(event.raw).data?.options)
      const platform = options.get("platform") as TrackingPlatform | undefined
      const handle = options.get("handle")
      if (!platform || !handle) { await post("Both `platform` and `handle` are required."); return }
      const removed = await Effect.runPromise(store.removeTrackedHandle(context.channelId, platform, normalizeHandle(handle)))
      await post(removed ? `**Removed:** Stopped tracking ${platformLabel(platform)} handle \`${handle}\`.` : "That handle is not currently tracked in this channel.")
    })

    onCommand("/track-list", async (event, post) => {
      const raw = asInteractionRaw(event.raw)
      const context = getChannelContext(raw)
      if (!context) { await post("Use this command inside a Discord server text channel."); return }
      const trackedHandles = await Effect.runPromise(store.listTrackedHandlesByChannel(context.channelId))
      await post([
        "## Tracked Handles",
        "",
        trackedHandles.length === 0
          ? "none"
          : await renderTrackedByUser(trackedHandles)
      ].join("\n"))
    })

    onCommand("/leaderboard", async (event, post) => {
      const raw = asInteractionRaw(event.raw)
      const context = getChannelContext(raw)
      if (!context) { await post("Use this command inside a Discord server text channel."); return }
      const leaderboard = await Effect.runPromise(store.getLeaderboard(context.channelId))
      if (leaderboard.length === 0) { await post("No rated users tracked in this channel yet."); return }
      await post([
        "## Leaderboard",
        "",
        ...leaderboard.map((entry, i) => {
          const url = entry.platform === "codeforces"
            ? `https://codeforces.com/profile/${encodeURIComponent(entry.handle)}`
            : `https://atcoder.jp/users/${encodeURIComponent(entry.handle)}`
          const rank = entry.rankLabel ? `  ${entry.rankLabel}` : ""
          return `**${i + 1}.** [${entry.handle}](<${url}>)  ${platformLabel(entry.platform)}  ${entry.rating ?? "unrated"}${rank}`
        })
      ].join("\n"))
    })

    onCommand("/rating", async (event, post) => {
      const options = flattenOptions(asInteractionRaw(event.raw).data?.options)
      const platform = options.get("platform") as TrackingPlatform | undefined
      const handle = options.get("handle")
      if (!platform || !handle) { await post("Both `platform` and `handle` are required."); return }
      const profileResult = await Effect.runPromise(profileService.fetchProfile(platform, handle).pipe(Effect.either))
      if (profileResult._tag === "Left") {
        await post(`Could not find \`${handle}\` on ${platformLabel(platform)}. Check the handle and try again.`)
        return
      }
      const profile = profileResult.right
      await post([
        `## ${platformLabel(platform)} Rating`,
        `> **[${profile.handle}](<${profile.profileUrl}>)**  \`${profile.rating ?? "Unrated"}\`${profile.rankLabel ? `  *${profile.rankLabel}*` : ""}${profile.maxRating ? `  ·  max \`${profile.maxRating}\`` : ""}`
      ].join("\n"))
    })

    onCommand("/compare", async (event, post) => {
      const options = flattenOptions(asInteractionRaw(event.raw).data?.options)
      const platform = options.get("platform") as TrackingPlatform | undefined
      const handleA = options.get("handle_a")
      const handleB = options.get("handle_b")
      if (!platform || !handleA || !handleB) { await post("`platform`, `handle_a`, and `handle_b` are required."); return }
      const [leftResult, rightResult] = await Promise.all([
        Effect.runPromise(profileService.fetchProfile(platform, handleA).pipe(Effect.either)),
        Effect.runPromise(profileService.fetchProfile(platform, handleB).pipe(Effect.either))
      ])
      if (leftResult._tag === "Left") {
        await post(`Could not find \`${handleA}\` on ${platformLabel(platform)}.`)
        return
      }
      if (rightResult._tag === "Left") {
        await post(`Could not find \`${handleB}\` on ${platformLabel(platform)}.`)
        return
      }
      const left = leftResult.right
      const right = rightResult.right
      const fmt = (p: typeof left) => `> **[${p.handle}](<${p.profileUrl}>)**  \`${p.rating ?? "Unrated"}\`${p.rankLabel ? `  *${p.rankLabel}*` : ""}${p.maxRating ? `  ·  max \`${p.maxRating}\`` : ""}`
      await post([`## ${platformLabel(platform)} Comparison`, "", fmt(left), fmt(right)].join("\n"))
    })

    onCommand("/streak", async (event, post) => {
      const raw = asInteractionRaw(event.raw)
      const context = getChannelContext(raw)
      if (!context) { await post("Use this command inside a Discord server text channel."); return }
      const options = flattenOptions(raw.data?.options)
      const platform = options.get("platform") as TrackingPlatform | undefined
      const handle = options.get("handle")
      if (!platform || !handle) { await post("Both `platform` and `handle` are required."); return }
      const trackedHandle = await Effect.runPromise(store.getTrackedHandleByChannel(context.channelId, platform, normalizeHandle(handle)))
      if (!trackedHandle) { await post("That handle is not tracked in this channel yet."); return }
      const count = await Effect.runPromise(store.countImprovementSnapshots(context.channelId, platform, trackedHandle.handleNormalized))
      await post(`## Streak\n> \`${trackedHandle.handle}\`  **${count}** improvement${count === 1 ? "" : "s"} recorded`)
    })

    if (config.isDev) {
      onCommand("/simulate", async (event, post) => {
        const raw = asInteractionRaw(event.raw)
        const context = getChannelContext(raw)
        if (!context) { await post("Use this command inside a server text channel."); return }

        const tz = await getChannelTimeZone(context.channelId)

        // 1. Real digest
        const digest = await Effect.runPromise(digestService.getDigest("tomorrow", tz))
        await post(digest.message)

        // 2. One real announcement per tracked handle
        const [subscription, handles] = await Promise.all([
          Effect.runPromise(store.getSubscriptionByChannel(context.channelId)),
          Effect.runPromise(store.listTrackedHandlesByChannel(context.channelId))
        ])
        if (subscription) {
          for (const h of handles) {
            const fakeRating = 1200 + Math.floor(Math.random() * 1600)
            const fakePrev = fakeRating - (25 + Math.floor(Math.random() * 75))
            const fakeRank = h.platform === "codeforces" ? "Specialist" : "Green"
            const fakeHandle = {
              ...subscription,
              trackedHandleId: h.id,
              platform: h.platform,
              handle: h.handle,
              handleNormalized: h.handleNormalized,
              handleCreatedByUserId: h.createdByUserId
            }
            const delta = fakeRating - fakePrev
            const quote = await generateMotivationalQuote(config.groqApiKey, h.handle, h.platform, delta, fakeRating, fakeRank).catch(() => "")
            await post(buildTrackingAnnouncement(fakeHandle, fakeRating, fakeRank, fakePrev) + (quote ? `\n\n*${quote}*` : ""))
          }
        }
      })
    }

    chat.onNewMessage(/^!oops/i, async (thread, message) => {
      console.log(`[Oops] Triggered by ${message.author.userName} in thread ${message.threadId}`)
      try {
        const excuse = await generateShameExcuse()
        console.log(`[Oops] Responding: ${excuse}`)
        await thread.post(excuse)
      } catch (error) {
        console.error("[Oops] Handler failed:", error instanceof Error ? error.message : error)
      }
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
      registerCommands: registerSlashCommands(httpClient, config.discordBotToken, config.discordApplicationId, config.isDev),
      startGateway: Effect.gen(function* () {
        const sessionMs = 23 * 60 * 60 * 1000
        while (true) {
          yield* Effect.logInfo("[Gateway] Starting Discord Gateway session")
          yield* Effect.tryPromise({
            try: () => new Promise<void>((resolve, reject) => {
              discordAdapter.startGatewayListener(
                { waitUntil: (p) => (p as Promise<void>).then(resolve, reject) },
                sessionMs
              ).catch(reject)
            }),
            catch: (cause) => new DiscordIntegrationError({ operation: "startGateway", reason: "Gateway session failed", cause })
          }).pipe(Effect.catchAll((e) => {
            const cause = e.cause instanceof Error ? e.cause.message : String(e.cause)
            return Effect.logError(`[Gateway] Session error: ${e.reason} — ${cause}`)
          }))
          yield* Effect.logInfo("[Gateway] Session ended, reconnecting in 5s")
          yield* Effect.sleep(5000)
        }
      }) as Effect.Effect<never, DiscordIntegrationError>
    }
  })
)
