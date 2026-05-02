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
