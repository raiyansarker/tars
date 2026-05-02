import { AsyncResource } from "node:async_hooks";
import { createDiscordAdapter } from "@chat-adapter/discord";
import { createIoRedisState } from "@chat-adapter/state-ioredis";
import {
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
} from "@effect/platform";
import { Chat, type SlashCommandEvent } from "chat";
import { Context, Data, Effect, Layer } from "effect";

import { AppConfig } from "../config";
import type { TrackingPlatform } from "../domain/bot-state";
import { ContestDigestService, renderContestLine } from "./contest-digest";
import { ProfileSourceService } from "./profile-sources";
import { DbService } from "./db";
import { buildTrackingAnnouncement } from "../lib/announcements";
import { generateMotivationalQuote, generateShameExcuse } from "./no";
import { fetchRandomProblem } from "../lib/codeforces";
import {
  formatDeliveryTime,
  isValidTimeZone,
  parseDeliveryTime,
  computeNextDeliveryAt,
} from "../lib/time";
import { normalizeHandle, escHandle } from "../lib/tracking";

export class DiscordIntegrationError extends Data.TaggedError(
  "DiscordIntegrationError",
)<{
  readonly operation: string;
  readonly reason: string;
  readonly cause?: unknown;
}> {}

export interface DiscordBotService {
  readonly handleWebhook: (
    request: Request,
  ) => Effect.Effect<Response, DiscordIntegrationError>;
  readonly postChannelMessage: (
    guildId: string,
    channelId: string,
    message: string,
  ) => Effect.Effect<
    { readonly messageId: string | null },
    DiscordIntegrationError
  >;
  readonly registerCommands: Effect.Effect<void, DiscordIntegrationError>;
  readonly startGateway: Effect.Effect<never, DiscordIntegrationError>;
}

export const DiscordBotService =
  Context.GenericTag<DiscordBotService>("DiscordBotService");

interface DiscordInteractionOption {
  readonly name?: string;
  readonly value?: string | number | boolean;
  readonly options?: ReadonlyArray<DiscordInteractionOption>;
}

interface DiscordInteractionRaw {
  readonly guild_id?: string;
  readonly channel_id?: string;
  readonly token?: string;
  readonly channel?: {
    readonly name?: string;
    readonly type?: number;
    readonly parent_id?: string;
  };
  readonly member?: { readonly permissions?: string };
  readonly data?: {
    readonly options?: ReadonlyArray<DiscordInteractionOption>;
  };
}

const ADMINISTRATOR = 0x8n;
const MANAGE_CHANNELS = 0x10n;
const ADMIN_PERMISSION = "16";

const channelRef = (guildId: string, channelId: string) =>
  `discord:${guildId}:${channelId}`;
const platformLabel = (p: TrackingPlatform) =>
  p === "codeforces" ? "codeforces" : "atcoder";
const profileUrl = (p: TrackingPlatform, handle: string) =>
  p === "codeforces"
    ? `https://codeforces.com/profile/${encodeURIComponent(handle)}`
    : `https://atcoder.jp/users/${encodeURIComponent(handle)}`;

const PLATFORM_CHOICES = [
  { name: "codeforces", value: "codeforces" },
  { name: "atcoder", value: "atcoder" },
];

const commandDefinitions = [
  {
    name: "digest",
    description: "Manage scheduled contest digests for this channel.",
    default_member_permissions: ADMIN_PERMISSION,
    options: [
      {
        type: 1,
        name: "setup",
        description: "Enable or update scheduled digests.",
        options: [
          {
            type: 3,
            name: "time",
            description: "24-hour time like 21:00",
            required: true,
          },
          {
            type: 3,
            name: "timezone",
            description: "IANA timezone like Asia/Dhaka",
            required: true,
          },
        ],
      },
      {
        type: 1,
        name: "disable",
        description: "Disable scheduled digests in this channel.",
      },
      {
        type: 1,
        name: "time",
        description: "Update delivery time.",
        options: [
          {
            type: 3,
            name: "value",
            description: "24-hour time like 21:00",
            required: true,
          },
        ],
      },
      {
        type: 1,
        name: "tz",
        description: "Update timezone.",
        options: [
          {
            type: 3,
            name: "value",
            description: "IANA timezone like Asia/Dhaka",
            required: true,
          },
        ],
      },
      {
        type: 1,
        name: "mention",
        description: "Set a role to ping with the digest.",
        options: [
          {
            type: 8,
            name: "value",
            description: "Role to mention",
            required: true,
          },
        ],
      },
      {
        type: 1,
        name: "mention-clear",
        description: "Remove the role mention.",
      },
      { type: 1, name: "test", description: "Preview tomorrow's digest." },
      {
        type: 1,
        name: "status",
        description: "Show digest schedule for this channel.",
      },
    ],
  },
  {
    name: "channel",
    description: "Manage bot command channels for this server.",
    default_member_permissions: ADMIN_PERMISSION,
    options: [
      {
        type: 1,
        name: "allow",
        description: "Allow bot commands in this channel.",
      },
      {
        type: 1,
        name: "disallow",
        description: "Remove this channel from the allowlist.",
      },
      {
        type: 1,
        name: "list",
        description: "List all allowed command channels.",
      },
    ],
  },
  {
    name: "track",
    description: "Manage tracked handles for this server.",
    options: [
      {
        type: 1,
        name: "add",
        description: "Start tracking a handle.",
        options: [
          {
            type: 3,
            name: "platform",
            description: "Platform",
            required: true,
            choices: PLATFORM_CHOICES,
          },
          {
            type: 3,
            name: "handle",
            description: "Handle to track",
            required: true,
          },
        ],
      },
      {
        type: 1,
        name: "remove",
        description: "Stop tracking a handle.",
        options: [
          {
            type: 3,
            name: "platform",
            description: "Platform",
            required: true,
            choices: PLATFORM_CHOICES,
          },
          {
            type: 3,
            name: "handle",
            description: "Handle to remove",
            required: true,
          },
        ],
      },
      {
        type: 1,
        name: "list",
        description: "List tracked handles in this server.",
      },
    ],
  },
  {
    name: "track-for",
    description: "Add tracking for another user (admin only).",
    default_member_permissions: ADMIN_PERMISSION,
    options: [
      { type: 6, name: "user", description: "Discord user", required: true },
      {
        type: 3,
        name: "platform",
        description: "Platform",
        required: true,
        choices: PLATFORM_CHOICES,
      },
      {
        type: 3,
        name: "handle",
        description: "Handle to track",
        required: true,
      },
    ],
  },
  {
    name: "contest",
    description: "Browse upcoming contests.",
    options: [
      { type: 1, name: "today", description: "Contests happening today." },
      { type: 1, name: "tomorrow", description: "Tomorrow's contests." },
      {
        type: 1,
        name: "upcoming",
        description: "Contests over the next N days.",
        options: [
          {
            type: 4,
            name: "days",
            description: "Days to look ahead (default 7, max 30)",
            required: false,
          },
        ],
      },
      { type: 1, name: "next", description: "The very next upcoming contest." },
      {
        type: 1,
        name: "lucky",
        description: "Random contest from tomorrow's pool.",
      },
    ],
  },
  {
    name: "profile",
    description: "Look up competitive programming profiles.",
    options: [
      {
        type: 1,
        name: "rating",
        description: "Current rating for a handle.",
        options: [
          {
            type: 3,
            name: "platform",
            description: "Platform",
            required: true,
            choices: PLATFORM_CHOICES,
          },
          { type: 3, name: "handle", description: "Handle", required: true },
        ],
      },
      {
        type: 1,
        name: "compare",
        description: "Compare two handles.",
        options: [
          {
            type: 3,
            name: "platform",
            description: "Platform",
            required: true,
            choices: PLATFORM_CHOICES,
          },
          {
            type: 3,
            name: "handle_a",
            description: "First handle",
            required: true,
          },
          {
            type: 3,
            name: "handle_b",
            description: "Second handle",
            required: true,
          },
        ],
      },
      {
        type: 1,
        name: "streak",
        description: "Rating improvements recorded for a handle.",
        options: [
          {
            type: 3,
            name: "platform",
            description: "Platform",
            required: true,
            choices: PLATFORM_CHOICES,
          },
          { type: 3, name: "handle", description: "Handle", required: true },
        ],
      },
      {
        type: 1,
        name: "info",
        description: "Tracked handles and ratings for a Discord user.",
        options: [
          {
            type: 6,
            name: "user",
            description: "Discord user to look up",
            required: true,
          },
        ],
      },
    ],
  },
  { name: "leaderboard", description: "Top 10 rated users in this server." },
  {
    name: "random",
    description: "Random Codeforces problem suited to your rating.",
    options: [
      {
        type: 3,
        name: "difficulty",
        description: "Difficulty relative to your rating",
        required: false,
        choices: [
          { name: "easy (+-100)", value: "easy" },
          { name: "medium (+200-400)", value: "medium" },
          { name: "hard (+400-600)", value: "hard" },
        ],
      },
    ],
  },
  { name: "help", description: "Show command help." },
];

const hasAdminPermissions = (raw: DiscordInteractionRaw): boolean => {
  if (!raw.member?.permissions) return false;
  const p = BigInt(raw.member.permissions);
  return (
    (p & ADMINISTRATOR) === ADMINISTRATOR ||
    (p & MANAGE_CHANNELS) === MANAGE_CHANNELS
  );
};

const flattenOptions = (
  options: ReadonlyArray<DiscordInteractionOption> | undefined,
): Map<string, string> => {
  const values = new Map<string, string>();
  const walk = (items: ReadonlyArray<DiscordInteractionOption> | undefined) => {
    if (!items) return;
    for (const item of items) {
      if (item.name && item.value !== undefined)
        values.set(item.name, String(item.value));
      if (item.options) walk(item.options);
    }
  };
  walk(options);
  return values;
};

const asInteractionRaw = (raw: unknown): DiscordInteractionRaw =>
  raw as DiscordInteractionRaw;

const getChannelContext = (raw: DiscordInteractionRaw) => {
  if (!raw.guild_id || !raw.channel_id) return null;
  return {
    guildId: raw.guild_id,
    channelId: raw.channel_id,
    guildName: null,
    channelName: raw.channel?.name ?? null,
  };
};

const isUnsupportedChannelType = (raw: DiscordInteractionRaw): boolean => {
  const t = raw.channel?.type;
  return t === 11 || t === 12 || t === 15;
};

const buildHelpMessage = (defaultTimeZone: string, defaultTime: string) =>
  [
    "## Contest Digest Bot",
    `> -# Default TZ \`${defaultTimeZone}\`  ·  Time \`${defaultTime}\``,
    "",
    "**Setup** *(admin only)*",
    "`/digest setup` — Enable digests with a time and timezone",
    "`/digest disable` — Stop scheduled digests",
    "`/digest time` — Change delivery time",
    "`/digest tz` — Change timezone",
    "`/digest mention` — Set a role to ping",
    "`/digest mention-clear` — Remove role mention",
    "`/digest test` — Preview tomorrow's digest",
    "`/digest status` — Show digest schedule",
    "",
    "**Channel** *(admin only)*",
    "`/channel allow` — Allow bot commands in this channel",
    "`/channel disallow` — Remove this channel from allowlist",
    "`/channel list` — List allowed command channels",
    "",
    "**Contests**",
    "`/contest today` — Contests today",
    "`/contest tomorrow` — Tomorrow's contests",
    "`/contest upcoming` — Contests over next N days",
    "`/contest next` — Next upcoming contest",
    "`/contest lucky` — Random contest from tomorrow",
    "",
    "**Tracking**",
    "`/track add` — Track a handle",
    "`/track remove` — Stop tracking a handle",
    "`/track list` — List tracked handles",
    "`/track-for` — Add tracking for another user (admin only)",
    "`/leaderboard` — Top 10 rated users",
    "`/random` — Random Codeforces problem",
    "",
    "**Profile**",
    "`/profile rating` — Current rating",
    "`/profile compare` — Compare two handles",
    "`/profile streak` — Rating improvements recorded",
    "`/profile info` — Handles for a Discord user",
    "",
    "**Fun**",
    "`!oops` — Get an excuse",
  ].join("\n");

const registerSlashCommands = (
  httpClient: HttpClient.HttpClient,
  token: string,
  applicationId: string,
  isDev = false,
): Effect.Effect<void, DiscordIntegrationError> => {
  const commands = isDev
    ? [
        ...commandDefinitions,
        { name: "simulate", description: "[DEV] Simulate bot events." },
      ]
    : commandDefinitions;
  return HttpClientRequest.put(
    `https://discord.com/api/v10/applications/${applicationId}/commands`,
  ).pipe(
    HttpClientRequest.setHeader("Authorization", `Bot ${token}`),
    HttpClientRequest.setHeader("Accept", "application/json"),
    (req) => HttpClientRequest.bodyJson(req, commands),
    Effect.mapError(
      (cause) =>
        new DiscordIntegrationError({
          operation: "registerCommands",
          reason: "Failed to build request",
          cause,
        }),
    ),
    Effect.flatMap((req) => httpClient.execute(req)),
    Effect.flatMap(HttpClientResponse.filterStatusOk),
    Effect.asVoid,
    Effect.mapError((cause) =>
      cause instanceof DiscordIntegrationError
        ? cause
        : new DiscordIntegrationError({
            operation: "registerCommands",
            reason: "Failed to register slash commands",
            cause,
          }),
    ),
  );
};

export const DiscordBotServiceLive = Layer.scoped(
  DiscordBotService,
  Effect.gen(function* () {
    const config = yield* AppConfig;
    const httpClient = yield* HttpClient.HttpClient;
    const db = yield* DbService;
    const digestService = yield* ContestDigestService;
    const profileService = yield* ProfileSourceService;

    const helpMessage = buildHelpMessage(
      config.defaultTimeZone,
      formatDeliveryTime(
        config.defaultDeliveryHour,
        config.defaultDeliveryMinute,
      ),
    );

    const fetchUsername = async (userId: string): Promise<string> => {
      try {
        const res = await fetch(`https://discord.com/api/v10/users/${userId}`, {
          headers: { Authorization: `Bot ${config.discordBotToken}` },
        });
        if (!res.ok) return userId;
        const data = (await res.json()) as {
          username?: string;
          global_name?: string;
        };
        return data.global_name ?? data.username ?? userId;
      } catch {
        return userId;
      }
    };

    const renderTrackedByUser = async (
      handles: ReadonlyArray<import("../domain/bot-state").TrackedHandle>,
    ): Promise<string> => {
      const grouped = new Map<string, (typeof handles)[number][]>();
      for (const h of handles) {
        const g = grouped.get(h.createdByUserId) ?? [];
        g.push(h);
        grouped.set(h.createdByUserId, g);
      }
      const sections = await Promise.all(
        [...grouped.entries()].map(async ([userId, hs]) => {
          const name = await fetchUsername(userId);
          return (
            `**${name}**\n` +
            hs
              .map(
                (h) =>
                  `  [${escHandle(h.handle)}](<${profileUrl(h.platform, h.handle)}>)  ${platformLabel(h.platform)}`,
              )
              .join("\n")
          );
        }),
      );
      return sections.join("\n\n");
    };

    const discordAdapter = createDiscordAdapter();
    const chat = new Chat({
      userName: config.botUserName,
      adapters: { discord: discordAdapter },
      state: createIoRedisState({
        url: config.redisUrl,
        keyPrefix: "tars-chat",
        logger: {
          ...console,
          child: () => ({ ...console, child: () => console as any }),
        } as any,
      }),
    });

    {
      const original = (chat as any).handleSlashCommandEvent.bind(chat);
      (chat as any).handleSlashCommandEvent = (
        event: unknown,
        options: unknown,
      ) => AsyncResource.bind(() => original(event, options))();
    }

    const getChannelTimeZone = async (
      channelId: string | undefined,
    ): Promise<string> => {
      if (!channelId) return config.defaultTimeZone;
      const sub = await Effect.runPromise(
        db.getSubscriptionByChannel(channelId).pipe(
          Effect.catchAll((e) => {
            Effect.runPromise(
              Effect.logError(
                `[bot] getChannelTimeZone failed channel=${channelId}: ${e.operation}`,
              ),
            );
            return Effect.succeed(null);
          }),
        ),
      );
      return sub?.timezone ?? config.defaultTimeZone;
    };

    // Guard: admin commands — requires guild context + admin perms
    const requireAdminChannel = async (
      event: SlashCommandEvent,
      post: (msg: string) => Promise<void>,
    ): Promise<{
      guildId: string;
      channelId: string;
      guildName: string | null;
      channelName: string | null;
    } | null> => {
      const raw = asInteractionRaw(event.raw);
      const context = getChannelContext(raw);
      if (!context) {
        await post("Use this command inside a Discord server text channel.");
        return null;
      }
      if (isUnsupportedChannelType(raw)) {
        await post(
          "Run this command in a regular text or announcement channel.",
        );
        return null;
      }
      if (!hasAdminPermissions(raw)) {
        await post(
          "You need `Manage Channels` or `Administrator` permission for this command.",
        );
        return null;
      }
      return context;
    };

    // Guard: non-admin commands — requires guild context + allowed channel
    const requireCommandChannel = async (
      event: SlashCommandEvent,
      post: (msg: string) => Promise<void>,
    ): Promise<{
      guildId: string;
      channelId: string;
      guildName: string | null;
      channelName: string | null;
    } | null> => {
      const raw = asInteractionRaw(event.raw);
      const context = getChannelContext(raw);
      if (!context) {
        await post("Use this command inside a Discord server text channel.");
        return null;
      }
      if (isUnsupportedChannelType(raw)) {
        await post(
          "Run this command in a regular text or announcement channel.",
        );
        return null;
      }
      const allowedResult = await Effect.runPromise(
        db.listCommandChannels(context.guildId).pipe(Effect.either),
      );
      if (allowedResult._tag === "Left") {
        await Effect.runPromise(
          Effect.logError(
            `[bot] requireCommandChannel db error guild=${context.guildId}: ${allowedResult.left.operation}`,
          ),
        );
        await post(
          "Could not check command channel permissions. Try again later.",
        );
        return null;
      }
      const allowed = allowedResult.right;
      if (allowed.length === 0) {
        await post(
          "No command channels configured. An admin must run `/channel allow` first.",
        );
        return null;
      }
      if (!allowed.includes(context.channelId)) {
        await post(
          `Commands are only allowed in: ${allowed.map((id) => `<#${id}>`).join(", ")}`,
        );
        return null;
      }
      return context;
    };

    const onCommand = (
      name: string,
      handler: (
        event: SlashCommandEvent,
        post: (msg: string) => Promise<void>,
      ) => Promise<void>,
    ) => {
      chat.onSlashCommand(name, (event) => {
        const post = async (msg: string) => {
          await event.channel.post(msg);
        };
        return (async () => {
          const start = Date.now();
          try {
            await Effect.runPromise(
              Effect.logInfo(`[cmd] ${name}  user=${event.user.userName}`),
            );
            await handler(event, post);
            await Effect.runPromise(
              Effect.logDebug(`[cmd] ${name}  done  ${Date.now() - start}ms`),
            );
          } catch (error) {
            await Effect.runPromise(
              Effect.logError(
                `[cmd] ${name}  failed  ${error instanceof Error ? error.message : String(error)}`,
              ),
            );
            try {
              await post("The command failed to complete.");
            } catch {}
          }
        })();
      });
    };

    // ── /help ────────────────────────────────────────────────────────────────
    onCommand("/help", async (_, post) => {
      await post(helpMessage);
    });

    // ── /digest ───────────────────────────────────────────────────────────────
    // SDK only appends subcommand to path when it has nested options.
    // Register both parent ("/digest") and full path ("/digest setup" etc.) to
    // cover both cases.
    const digestHandler = async (
      event: SlashCommandEvent,
      post: (msg: string) => Promise<void>,
    ) => {
      const raw = asInteractionRaw(event.raw);
      const sub = raw.data?.options?.[0]?.name;
      const options = flattenOptions(raw.data?.options);

      if (sub === "setup") {
        const context = await requireAdminChannel(event, post);
        if (!context) return;
        const time = options.get("time");
        const timezone = options.get("timezone");
        if (!time || !timezone) {
          await post("Both `time` and `timezone` are required.");
          return;
        }
        const parsedTime = parseDeliveryTime(time);
        if (!parsedTime) {
          await post("Use a 24-hour time like `21:00`.");
          return;
        }
        if (!isValidTimeZone(timezone)) {
          await post("That timezone is not a valid IANA timezone.");
          return;
        }
        const subscription = await Effect.runPromise(
          db.upsertSubscription({
            ...context,
            timezone,
            deliveryHour: parsedTime.hour,
            deliveryMinute: parsedTime.minute,
            createdByUserId: event.user.userId,
          }),
        );
        await post(
          `Setup complete. Scheduled digests enabled for <#${subscription.channelId}> at \`${formatDeliveryTime(subscription.deliveryHour, subscription.deliveryMinute)}\` (${subscription.timezone}).`,
        );
        return;
      }
      if (sub === "disable") {
        const context = await requireAdminChannel(event, post);
        if (!context) return;
        const disabled = await Effect.runPromise(
          db.disableSubscription(context.channelId),
        );
        await post(
          disabled
            ? "Scheduled digests disabled for this channel."
            : "This channel was not configured yet.",
        );
        return;
      }
      if (sub === "time") {
        const context = await requireAdminChannel(event, post);
        if (!context) return;
        const parsedTime = options.get("value")
          ? parseDeliveryTime(options.get("value")!)
          : null;
        if (!parsedTime) {
          await post("Provide a valid 24-hour time like `21:00`.");
          return;
        }
        const updated = await Effect.runPromise(
          db.updateSubscriptionDeliveryTime(
            context.channelId,
            parsedTime.hour,
            parsedTime.minute,
          ),
        );
        await post(
          updated
            ? `Delivery time changed to \`${formatDeliveryTime(updated.deliveryHour, updated.deliveryMinute)}\`.`
            : "Run `/digest setup` first.",
        );
        return;
      }
      if (sub === "tz") {
        const context = await requireAdminChannel(event, post);
        if (!context) return;
        const timezone = options.get("value");
        if (!timezone || !isValidTimeZone(timezone)) {
          await post("Provide a valid IANA timezone (e.g., `Asia/Dhaka`).");
          return;
        }
        const updated = await Effect.runPromise(
          db.updateSubscriptionTimeZone(context.channelId, timezone),
        );
        await post(
          updated
            ? `Timezone changed to \`${updated.timezone}\`.`
            : "Run `/digest setup` first.",
        );
        return;
      }
      if (sub === "mention") {
        const context = await requireAdminChannel(event, post);
        if (!context) return;
        const roleId = options.get("value");
        if (!roleId) {
          await post("Provide a role.");
          return;
        }
        const updated = await Effect.runPromise(
          db.updateSubscriptionMentionRole(context.channelId, roleId),
        );
        await post(
          updated
            ? `Role set. Digest will mention <@&${roleId}>.`
            : "Run `/digest setup` first.",
        );
        return;
      }
      if (sub === "mention-clear") {
        const context = await requireAdminChannel(event, post);
        if (!context) return;
        const updated = await Effect.runPromise(
          db.updateSubscriptionMentionRole(context.channelId, null),
        );
        await post(
          updated ? "Role mention cleared." : "Run `/digest setup` first.",
        );
        return;
      }
      if (sub === "test") {
        const context = await requireAdminChannel(event, post);
        if (!context) return;
        const subscription = await Effect.runPromise(
          db
            .getSubscriptionByChannel(context.channelId)
            .pipe(Effect.orElseSucceed(() => null)),
        );
        const timeZone = subscription?.timezone ?? config.defaultTimeZone;
        await post(
          (
            await Effect.runPromise(
              digestService.getDigest("tomorrow", timeZone),
            )
          ).message,
        );
        return;
      }
      if (sub === "status") {
        const context = await requireAdminChannel(event, post);
        if (!context) return;
        const subscription = await Effect.runPromise(
          db
            .getSubscriptionByChannel(context.channelId)
            .pipe(Effect.orElseSucceed(() => null)),
        );
        if (!subscription) {
          await post(
            "This channel is not configured yet. Run `/digest setup time:<HH:MM> timezone:<IANA>`.",
          );
          return;
        }
        const nextRun = computeNextDeliveryAt(
          new Date(),
          subscription.timezone,
          subscription.deliveryHour,
          subscription.deliveryMinute,
        );
        await post(
          [
            `## Status — <#${subscription.channelId}>`,
            `> Digest \`${subscription.enabled ? "on" : "off"}\`  ·  Timezone \`${subscription.timezone}\`  ·  Daily at \`${formatDeliveryTime(subscription.deliveryHour, subscription.deliveryMinute)}\`  ·  Next <t:${Math.floor(nextRun.getTime() / 1000)}:R>`,
          ].join("\n"),
        );
        return;
      }
      await post("Unknown subcommand.");
    };
    onCommand("/digest", digestHandler);
    onCommand("/digest setup", digestHandler);
    onCommand("/digest time", digestHandler);
    onCommand("/digest tz", digestHandler);
    onCommand("/digest mention", digestHandler);

    // ── /channel ──────────────────────────────────────────────────────────────
    const channelHandler = async (
      event: SlashCommandEvent,
      post: (msg: string) => Promise<void>,
    ) => {
      const context = await requireAdminChannel(event, post);
      if (!context) return;
      const sub = asInteractionRaw(event.raw).data?.options?.[0]?.name;
      if (sub === "allow") {
        await Effect.runPromise(
          db.addCommandChannel(context.guildId, context.channelId),
        );
        await post(
          `<#${context.channelId}> added to the bot command allowlist.`,
        );
        return;
      }
      if (sub === "disallow") {
        const removed = await Effect.runPromise(
          db.removeCommandChannel(context.guildId, context.channelId),
        );
        await post(
          removed
            ? `Removed <#${context.channelId}> from the allowlist.`
            : "This channel was not in the allowlist.",
        );
        return;
      }
      if (sub === "list") {
        const allowed = await Effect.runPromise(
          db
            .listCommandChannels(context.guildId)
            .pipe(Effect.orElseSucceed(() => [] as string[])),
        );
        await post(
          allowed.length === 0
            ? "No command channels configured yet."
            : `Allowed channels: ${allowed.map((id) => `<#${id}>`).join(", ")}`,
        );
        return;
      }
      await post("Unknown subcommand.");
    };
    onCommand("/channel", channelHandler);

    // ── /contest subcommands ──────────────────────────────────────────────────
    const contestHandler = async (
      event: SlashCommandEvent,
      post: (msg: string) => Promise<void>,
    ) => {
      const context = await requireCommandChannel(event, post);
      if (!context) return;
      const raw = asInteractionRaw(event.raw);
      const sub = raw.data?.options?.[0]?.name;
      const timeZone = await getChannelTimeZone(raw.channel_id);
      if (sub === "today") {
        await post(
          (await Effect.runPromise(digestService.getDigest("today", timeZone)))
            .message,
        );
        return;
      }
      if (sub === "tomorrow") {
        await post(
          (
            await Effect.runPromise(
              digestService.getDigest("tomorrow", timeZone),
            )
          ).message,
        );
        return;
      }
      if (sub === "upcoming") {
        const days = Math.min(
          Math.max(
            Number(flattenOptions(raw.data?.options).get("days") || "7"),
            1,
          ),
          30,
        );
        await post(
          (
            await Effect.runPromise(
              digestService.getUpcomingRange(days, timeZone),
            )
          ).message,
        );
        return;
      }
      if (sub === "next") {
        const contest = await Effect.runPromise(
          digestService.getNextUpcomingContest(timeZone),
        );
        if (!contest) {
          await post("No upcoming contests found right now.");
          return;
        }
        await post(
          ["## Next Up", "", renderContestLine(contest, timeZone)].join("\n"),
        );
        return;
      }
      if (sub === "lucky") {
        const contest = await Effect.runPromise(
          digestService.pickLuckyContest(timeZone),
        );
        if (!contest) {
          await post("No contest available for a lucky pick.");
          return;
        }
        await post(
          [
            "## Lucky Pick",
            "> -# bias: contests under 2h",
            "",
            renderContestLine(contest, timeZone),
          ].join("\n"),
        );
        return;
      }
      await post("Unknown subcommand.");
    };
    onCommand("/contest", contestHandler);
    onCommand("/contest upcoming", contestHandler);

    // ── /track subcommands ────────────────────────────────────────────────────
    const trackHandler = async (
      event: SlashCommandEvent,
      post: (msg: string) => Promise<void>,
    ) => {
      const context = await requireCommandChannel(event, post);
      if (!context) return;
      const raw = asInteractionRaw(event.raw);
      const sub = raw.data?.options?.[0]?.name;
      const options = flattenOptions(raw.data?.options);
      if (sub === "add") {
        const platform = options.get("platform") as
          | TrackingPlatform
          | undefined;
        const handle = options.get("handle");
        if (!platform || !handle) {
          await post("Both `platform` and `handle` are required.");
          return;
        }
        const profileResult = await Effect.runPromise(
          profileService.fetchProfile(platform, handle).pipe(Effect.either),
        );
        if (profileResult._tag === "Left") {
          await post(
            `Could not find \`${handle}\` on ${platformLabel(platform)}. Check the handle and try again.`,
          );
          return;
        }
        const profile = profileResult.right;
        const trackedHandle = await Effect.runPromise(
          db.addTrackedHandle(
            context.guildId,
            platform,
            profile.handle,
            normalizeHandle(profile.handle),
            event.user.userId,
          ),
        );
        await Effect.runPromise(
          db.insertRatingSnapshot({
            trackedHandleId: trackedHandle.id,
            rating: profile.rating,
            rankLabel: profile.rankLabel,
            maxRating: profile.maxRating,
            isImprovement: false,
            rawPayloadJson: profile.rawPayload,
          }),
        );
        await post(
          `Tracking started. Now monitoring ${platformLabel(platform)} handle \`${trackedHandle.handle}\` in this server.`,
        );
        return;
      }
      if (sub === "add-for") {
        if (!hasAdminPermissions(asInteractionRaw(event.raw))) {
          await post(
            "You need `Manage Channels` or `Administrator` permission for this command.",
          );
          return;
        }
        const targetUserId = options.get("user");
        const platform = options.get("platform") as
          | TrackingPlatform
          | undefined;
        const handle = options.get("handle");
        if (!targetUserId || !platform || !handle) {
          await post("`user`, `platform`, and `handle` are required.");
          return;
        }
        const profileResult = await Effect.runPromise(
          profileService.fetchProfile(platform, handle).pipe(Effect.either),
        );
        if (profileResult._tag === "Left") {
          await post(
            `Could not find \`${handle}\` on ${platformLabel(platform)}. Check the handle and try again.`,
          );
          return;
        }
        const profile = profileResult.right;
        const trackedHandle = await Effect.runPromise(
          db.addTrackedHandle(
            context.guildId,
            platform,
            profile.handle,
            normalizeHandle(profile.handle),
            targetUserId,
          ),
        );
        await Effect.runPromise(
          db.insertRatingSnapshot({
            trackedHandleId: trackedHandle.id,
            rating: profile.rating,
            rankLabel: profile.rankLabel,
            maxRating: profile.maxRating,
            isImprovement: false,
            rawPayloadJson: profile.rawPayload,
          }),
        );
        await post(
          `Tracking started. Monitoring ${platformLabel(platform)} handle \`${trackedHandle.handle}\` for <@${targetUserId}>.`,
        );
        return;
      }
      if (sub === "remove") {
        const platform = options.get("platform") as
          | TrackingPlatform
          | undefined;
        const handle = options.get("handle");
        if (!platform || !handle) {
          await post("Both `platform` and `handle` are required.");
          return;
        }
        const removed = await Effect.runPromise(
          db.removeTrackedHandle(
            context.guildId,
            platform,
            normalizeHandle(handle),
          ),
        );
        await post(
          removed
            ? `Stopped tracking ${platformLabel(platform)} handle \`${handle}\`.`
            : "That handle is not currently tracked in this server.",
        );
        return;
      }
      if (sub === "list") {
        const handles = await Effect.runPromise(
          db.listTrackedHandlesByGuild(context.guildId),
        );
        await post(
          [
            "## Tracked Handles",
            "",
            handles.length === 0 ? "none" : await renderTrackedByUser(handles),
          ].join("\n"),
        );
        return;
      }
      await post("Unknown subcommand.");
    };
    onCommand("/track", trackHandler);
    onCommand("/track add", trackHandler);
    onCommand("/track remove", trackHandler);

    onCommand("/track-for", async (event, post) => {
      const context = await requireAdminChannel(event, post);
      if (!context) return;
      const options = flattenOptions(asInteractionRaw(event.raw).data?.options);
      const targetUserId = options.get("user");
      const platform = options.get("platform") as TrackingPlatform | undefined;
      const handle = options.get("handle");
      if (!targetUserId || !platform || !handle) {
        await post("`user`, `platform`, and `handle` are required.");
        return;
      }
      const profileResult = await Effect.runPromise(
        profileService.fetchProfile(platform, handle).pipe(Effect.either),
      );
      if (profileResult._tag === "Left") {
        await post(
          `Could not find \`${handle}\` on ${platformLabel(platform)}. Check the handle and try again.`,
        );
        return;
      }
      const profile = profileResult.right;
      const trackedHandle = await Effect.runPromise(
        db.addTrackedHandle(
          context.guildId,
          platform,
          profile.handle,
          normalizeHandle(profile.handle),
          targetUserId,
        ),
      );
      await Effect.runPromise(
        db.insertRatingSnapshot({
          trackedHandleId: trackedHandle.id,
          rating: profile.rating,
          rankLabel: profile.rankLabel,
          maxRating: profile.maxRating,
          isImprovement: false,
          rawPayloadJson: profile.rawPayload,
        }),
      );
      await post(
        `Tracking started. Monitoring ${platformLabel(platform)} handle \`${trackedHandle.handle}\` for @${targetUserId}.`,
      );
    });

    // ── /profile subcommands ──────────────────────────────────────────────────
    const profileHandler = async (
      event: SlashCommandEvent,
      post: (msg: string) => Promise<void>,
    ) => {
      const context = await requireCommandChannel(event, post);
      if (!context) return;
      const raw = asInteractionRaw(event.raw);
      const sub = raw.data?.options?.[0]?.name;
      const options = flattenOptions(raw.data?.options);
      if (sub === "rating") {
        const platform = options.get("platform") as
          | TrackingPlatform
          | undefined;
        const handle = options.get("handle");
        if (!platform || !handle) {
          await post("Both `platform` and `handle` are required.");
          return;
        }
        const result = await Effect.runPromise(
          profileService.fetchProfile(platform, handle).pipe(Effect.either),
        );
        if (result._tag === "Left") {
          await post(
            `Could not find \`${handle}\` on ${platformLabel(platform)}.`,
          );
          return;
        }
        const p = result.right;
        await post(
          [
            `## ${platformLabel(platform)} rating`,
            `> **[${escHandle(p.handle)}](<${p.profileUrl}>)**  \`${p.rating ?? "Unrated"}\`${p.rankLabel ? `  *${p.rankLabel}*` : ""}${p.maxRating ? `  ·  max \`${p.maxRating}\`` : ""}`,
          ].join("\n"),
        );
        return;
      }
      if (sub === "compare") {
        const platform = options.get("platform") as
          | TrackingPlatform
          | undefined;
        const handleA = options.get("handle_a");
        const handleB = options.get("handle_b");
        if (!platform || !handleA || !handleB) {
          await post("`platform`, `handle_a`, and `handle_b` are required.");
          return;
        }
        const [lr, rr] = await Promise.all([
          Effect.runPromise(
            profileService.fetchProfile(platform, handleA).pipe(Effect.either),
          ),
          Effect.runPromise(
            profileService.fetchProfile(platform, handleB).pipe(Effect.either),
          ),
        ]);
        if (lr._tag === "Left") {
          await post(
            `Could not find \`${handleA}\` on ${platformLabel(platform)}.`,
          );
          return;
        }
        if (rr._tag === "Left") {
          await post(
            `Could not find \`${handleB}\` on ${platformLabel(platform)}.`,
          );
          return;
        }
        const fmt = (p: typeof lr.right) =>
          `> **[${escHandle(p.handle)}](<${p.profileUrl}>)**  \`${p.rating ?? "Unrated"}\`${p.rankLabel ? `  *${p.rankLabel}*` : ""}${p.maxRating ? `  ·  max \`${p.maxRating}\`` : ""}`;
        await post(
          [
            `## ${platformLabel(platform)} comparison`,
            "",
            fmt(lr.right),
            fmt(rr.right),
          ].join("\n"),
        );
        return;
      }
      if (sub === "streak") {
        const platform = options.get("platform") as
          | TrackingPlatform
          | undefined;
        const handle = options.get("handle");
        if (!platform || !handle) {
          await post("Both `platform` and `handle` are required.");
          return;
        }
        const tracked = await Effect.runPromise(
          db.getTrackedHandleByGuild(
            context.guildId,
            platform,
            normalizeHandle(handle),
          ),
        );
        if (!tracked) {
          await post("That handle is not tracked in this server yet.");
          return;
        }
        const count = await Effect.runPromise(
          db.countImprovementSnapshots(
            context.guildId,
            platform,
            tracked.handleNormalized,
          ),
        );
        await post(
          `## Streak\n> \`${tracked.handle}\`  **${count}** improvement${count === 1 ? "" : "s"} recorded`,
        );
        return;
      }
      if (sub === "info") {
        const targetUserId = options.get("user");
        if (!targetUserId) {
          await post("Provide a user to look up.");
          return;
        }
        const allHandles = await Effect.runPromise(
          db.listTrackedHandlesByGuild(context.guildId),
        );
        const handles = allHandles.filter(
          (h) => h.createdByUserId === targetUserId,
        );
        if (handles.length === 0) {
          await post("No tracked handles found for that user.");
          return;
        }
        const [displayName, snapshots] = await Promise.all([
          fetchUsername(targetUserId),
          Promise.all(
            handles.map((h) =>
              Effect.runPromise(
                db
                  .getLatestRatingSnapshot(h.id)
                  .pipe(Effect.orElseSucceed(() => null)),
              ),
            ),
          ),
        ]);
        const lines = handles.map((h, i) => {
          const snap = snapshots[i];
          const rating =
            snap?.rating != null ? `\`${snap.rating}\`` : "`Unrated`";
          const rank = snap?.rankLabel ? `  *${snap.rankLabel}*` : "";
          return `[${escHandle(h.handle)}](<${profileUrl(h.platform, h.handle)}>)  ${platformLabel(h.platform)}  ${rating}${rank}`;
        });
        await post([`## ${displayName}'s handles`, "", ...lines].join("\n"));
        return;
      }
      await post("Unknown subcommand.");
    };
    onCommand("/profile", profileHandler);
    onCommand("/profile rating", profileHandler);
    onCommand("/profile compare", profileHandler);
    onCommand("/profile streak", profileHandler);
    onCommand("/profile info", profileHandler);

    // ── /leaderboard ─────────────────────────────────────────────────────────
    onCommand("/leaderboard", async (event, post) => {
      const context = await requireCommandChannel(event, post);
      if (!context) return;
      const leaderboard = await Effect.runPromise(
        db.getLeaderboard(context.guildId),
      );
      if (leaderboard.length === 0) {
        await post("No rated users tracked in this server yet.");
        return;
      }
      await post(
        [
          "## Leaderboard",
          "",
          ...leaderboard.map((entry, i) => {
            const rank = entry.rankLabel ? `  ${entry.rankLabel}` : "";
            return `**${i + 1}.** [${escHandle(entry.handle)}](<${profileUrl(entry.platform, entry.handle)}>)  ${entry.rating ?? "unrated"}${rank}`;
          }),
        ].join("\n"),
      );
    });

    // ── /random ──────────────────────────────────────────────────────────────
    onCommand("/random", async (event, post) => {
      const context = await requireCommandChannel(event, post);
      if (!context) return;
      const raw = asInteractionRaw(event.raw);
      const handles = await Effect.runPromise(
        db.listTrackedHandlesByGuild(context.guildId),
      );
      const cfHandle = handles.find(
        (h) =>
          h.platform === "codeforces" &&
          h.createdByUserId === event.user.userId,
      );
      if (!cfHandle) {
        await post(
          "You don't have a codeforces handle tracked in this server. Use `/track add` first.",
        );
        return;
      }
      const profile = await Effect.runPromise(
        profileService
          .fetchProfile("codeforces", cfHandle.handle)
          .pipe(Effect.catchAll(() => Effect.succeed(null))),
      );
      const rating = profile?.rating ?? 800;
      const difficulty =
        flattenOptions(raw.data?.options).get("difficulty") ?? "medium";
      const [minRating, maxRating] =
        difficulty === "easy"
          ? [rating - 100, rating + 100]
          : difficulty === "hard"
            ? [rating + 400, rating + 600]
            : [rating, rating + 200];
      const problem = await Effect.runPromise(
        fetchRandomProblem(minRating, maxRating).pipe(
          Effect.provideService(HttpClient.HttpClient, httpClient),
          Effect.provideService(DbService, db),
        ),
      );
      if (!problem) {
        await post(
          `No problems found in the ${minRating}-${maxRating} rating range. Try again later.`,
        );
        return;
      }
      const tags =
        problem.tags.length > 0
          ? `\n> -# tags: ${problem.tags.join(", ")}`
          : "";
      await post(
        [
          `## [${problem.name}](<${problem.url}>)`,
          `> Rating: \`${problem.rating}\`  ·  For: \`${cfHandle.handle}\``,
          tags,
        ]
          .filter(Boolean)
          .join("\n"),
      );
    });

    // ── /simulate (dev only) ─────────────────────────────────────────────────
    if (config.isDev) {
      onCommand("/simulate", async (event, post) => {
        const raw = asInteractionRaw(event.raw);
        const context = getChannelContext(raw);
        if (!context) {
          await post("Use this command inside a server text channel.");
          return;
        }
        const tz = await getChannelTimeZone(context.channelId);
        const digest = await Effect.runPromise(
          digestService.getDigest("tomorrow", tz),
        );
        await post(digest.message);
        const [subscription, handles] = await Promise.all([
          Effect.runPromise(
            db
              .getSubscriptionByChannel(context.channelId)
              .pipe(Effect.orElseSucceed(() => null)),
          ),
          Effect.runPromise(db.listTrackedHandlesByGuild(context.guildId)),
        ]);
        if (subscription) {
          for (const h of handles) {
            const fakeRating = 1200 + Math.floor(Math.random() * 1600);
            const fakePrev = fakeRating - (25 + Math.floor(Math.random() * 75));
            const fakeRank =
              h.platform === "codeforces" ? "Specialist" : "Green";
            const fakeHandle = {
              ...subscription,
              trackedHandleId: h.id,
              platform: h.platform,
              handle: h.handle,
              handleNormalized: h.handleNormalized,
              handleCreatedByUserId: h.createdByUserId,
            };
            const delta = fakeRating - fakePrev;
            const quote = await generateMotivationalQuote(
              config.groqApiKey,
              h.handle,
              h.platform,
              delta,
              fakeRating,
              fakeRank,
            ).catch(() => "");
            await post(
              buildTrackingAnnouncement(
                fakeHandle,
                fakeRating,
                fakeRank,
                fakePrev,
              ) + (quote ? `\n\n*${quote}*` : ""),
            );
          }
        }
      });
    }

    // ── !oops (global, no guard) ─────────────────────────────────────────────
    chat.onNewMessage(/^!oops/i, async (thread, message) => {
      await Effect.runPromise(
        Effect.logInfo(`[oops] triggered by ${message.author.userName}`),
      );
      try {
        const excuse = await generateShameExcuse();
        await thread.post(excuse);
      } catch (error) {
        await Effect.runPromise(
          Effect.logError(
            `[oops] failed: ${error instanceof Error ? error.message : String(error)}`,
          ),
        );
      }
    });

    const initializedChat = yield* Effect.acquireRelease(
      Effect.tryPromise({
        try: async () => {
          await chat.initialize();
          return chat;
        },
        catch: (cause) =>
          new DiscordIntegrationError({
            operation: "initialize",
            reason: "Failed to initialize Chat SDK",
            cause,
          }),
      }),
      (instance) =>
        Effect.tryPromise({
          try: () => instance.shutdown(),
          catch: (cause) =>
            new DiscordIntegrationError({
              operation: "shutdown",
              reason: "Failed to shut down Chat SDK cleanly",
              cause,
            }),
        }).pipe(Effect.catchAll(() => Effect.void)),
    );

    return {
      handleWebhook: (request) =>
        Effect.gen(function* () {
          yield* Effect.logDebug(`[webhook] ${request.method} ${request.url}`);
          const response = yield* Effect.tryPromise({
            try: () => initializedChat.webhooks.discord(request),
            catch: (cause) =>
              new DiscordIntegrationError({
                operation: "handleWebhook",
                reason: "Discord webhook handling failed",
                cause,
              }),
          });
          yield* Effect.logInfo(
            `[webhook] processed status=${response.status}`,
          );
          return response;
        }),
      postChannelMessage: (guildId, channelId, message) =>
        Effect.tryPromise({
          try: async () => {
            const sent = await initializedChat
              .channel(channelRef(guildId, channelId))
              .post(message);
            return { messageId: sent.id || null };
          },
          catch: (cause) =>
            new DiscordIntegrationError({
              operation: "postChannelMessage",
              reason: "Failed to post message",
              cause,
            }),
        }),
      registerCommands: registerSlashCommands(
        httpClient,
        config.discordBotToken,
        config.discordApplicationId,
        config.isDev,
      ),
      startGateway: Effect.gen(function* () {
        const sessionMs = 23 * 60 * 60 * 1000;
        while (true) {
          yield* Effect.logInfo("[gateway] starting session");
          yield* Effect.tryPromise({
            try: () =>
              new Promise<void>((resolve, reject) => {
                discordAdapter
                  .startGatewayListener(
                    {
                      waitUntil: (p) =>
                        (p as Promise<void>).then(resolve, reject),
                    },
                    sessionMs,
                  )
                  .catch(reject);
              }),
            catch: (cause) =>
              new DiscordIntegrationError({
                operation: "startGateway",
                reason: "Gateway session failed",
                cause,
              }),
          }).pipe(
            Effect.catchAll((e) =>
              Effect.logError(
                `[gateway] session error: ${e.reason} — ${e.cause instanceof Error ? e.cause.message : String(e.cause)}`,
              ),
            ),
          );
          yield* Effect.logInfo("[gateway] session ended, reconnecting in 5s");
          yield* Effect.sleep(5000);
        }
      }) as Effect.Effect<never, DiscordIntegrationError>,
    };
  }),
);
