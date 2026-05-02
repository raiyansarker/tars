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
