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
