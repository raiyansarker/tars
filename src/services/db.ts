import { createClient } from "@libsql/client"
import { drizzle } from "drizzle-orm/libsql"
import { migrate } from "drizzle-orm/libsql/migrator"
import { and, count, desc, eq, sql } from "drizzle-orm"
import Redis from "ioredis"
import { Context, Data, Effect, Layer } from "effect"

import { AppConfig } from "../config"
import type {
  ChannelSubscription,
  RatingSnapshot,
  SchedulerTrackedHandle,
  TrackedHandle,
  TrackingPlatform,
} from "../domain/bot-state"
import {
  channelSubscriptions,
  commandChannels,
  ratingSnapshots,
  trackedHandles,
} from "../db/schema"

export class DbError extends Data.TaggedError("DbError")<{
  readonly operation: string
  readonly cause?: unknown
}> {}

export interface UpsertSubscriptionInput {
  readonly guildId: string
  readonly channelId: string
  readonly guildName: string | null
  readonly channelName: string | null
  readonly timezone: string
  readonly deliveryHour: number
  readonly deliveryMinute: number
  readonly createdByUserId: string
}

export interface InsertRatingSnapshotInput {
  readonly trackedHandleId: string
  readonly rating: number | null
  readonly rankLabel: string | null
  readonly maxRating: number | null
  readonly isImprovement: boolean
  readonly rawPayloadJson: unknown
}

export interface LeaderboardEntry {
  readonly handle: string
  readonly platform: TrackingPlatform
  readonly rating: number | null
  readonly rankLabel: string | null
}

export interface DbService {
  // subscriptions
  readonly upsertSubscription: (input: UpsertSubscriptionInput) => Effect.Effect<ChannelSubscription, DbError>
  readonly getSubscriptionByChannel: (channelId: string) => Effect.Effect<ChannelSubscription | null, DbError>
  readonly disableSubscription: (channelId: string) => Effect.Effect<boolean, DbError>
  readonly updateSubscriptionTimeZone: (channelId: string, timezone: string) => Effect.Effect<ChannelSubscription | null, DbError>
  readonly updateSubscriptionDeliveryTime: (channelId: string, hour: number, minute: number) => Effect.Effect<ChannelSubscription | null, DbError>
  readonly updateSubscriptionMentionRole: (channelId: string, roleId: string | null) => Effect.Effect<ChannelSubscription | null, DbError>
  readonly listEnabledSubscriptions: Effect.Effect<ReadonlyArray<ChannelSubscription>, DbError>
  // tracked handles
  readonly addTrackedHandle: (guildId: string, platform: TrackingPlatform, handle: string, handleNormalized: string, createdByUserId: string) => Effect.Effect<TrackedHandle, DbError>
  readonly removeTrackedHandle: (guildId: string, platform: TrackingPlatform, handleNormalized: string) => Effect.Effect<boolean, DbError>
  readonly getTrackedHandleByGuild: (guildId: string, platform: TrackingPlatform, handleNormalized: string) => Effect.Effect<TrackedHandle | null, DbError>
  readonly listTrackedHandlesByGuild: (guildId: string) => Effect.Effect<ReadonlyArray<TrackedHandle>, DbError>
  readonly listSchedulerTrackedHandles: Effect.Effect<ReadonlyArray<SchedulerTrackedHandle>, DbError>
  // snapshots
  readonly insertRatingSnapshot: (input: InsertRatingSnapshotInput) => Effect.Effect<RatingSnapshot, DbError>
  readonly getLatestRatingSnapshot: (trackedHandleId: string) => Effect.Effect<RatingSnapshot | null, DbError>
  readonly countImprovementSnapshots: (guildId: string, platform: TrackingPlatform, handleNormalized: string) => Effect.Effect<number, DbError>
  readonly getLeaderboard: (guildId: string) => Effect.Effect<ReadonlyArray<LeaderboardEntry>, DbError>
  // command channels
  readonly addCommandChannel: (guildId: string, channelId: string) => Effect.Effect<void, DbError>
  readonly removeCommandChannel: (guildId: string, channelId: string) => Effect.Effect<boolean, DbError>
  readonly listCommandChannels: (guildId: string) => Effect.Effect<ReadonlyArray<string>, DbError>
  // redis claims (exactly-once delivery)
  readonly claimDigestDelivery: (channelSubscriptionId: string, targetDateKey: string) => Effect.Effect<boolean, DbError>
  readonly completeDigestDelivery: (channelSubscriptionId: string, targetDateKey: string, messageId: string | null) => Effect.Effect<void, DbError>
  readonly releaseDigestDeliveryClaim: (channelSubscriptionId: string, targetDateKey: string) => Effect.Effect<void, DbError>
  readonly claimTrackingAnnouncement: (trackedHandleId: string, ratingSnapshotId: string) => Effect.Effect<boolean, DbError>
  readonly completeTrackingAnnouncement: (trackedHandleId: string, ratingSnapshotId: string, channelSubscriptionId: string, messageId: string | null) => Effect.Effect<void, DbError>
  readonly releaseTrackingAnnouncementClaim: (trackedHandleId: string, ratingSnapshotId: string) => Effect.Effect<void, DbError>
  // problem cache (for /random)
  readonly getCachedProblems: Effect.Effect<string | null, DbError>
  readonly setCachedProblems: (json: string) => Effect.Effect<void, DbError>
}

export const DbService = Context.GenericTag<DbService>("DbService")

// ── Redis key helpers ────────────────────────────────────────────────────────
const CLAIM_TTL = 60 * 20
const rSubKey = (channelId: string) => `tars:subscription:${channelId}`
const rSubIndexKey = "tars:subscriptions:enabled"
const rSnapshotKey = (id: string) => `tars:snapshot:latest:${id}`
const rDeliveryKey = (channelId: string, dateKey: string) => `tars:delivery:${channelId}:${dateKey}`
const rAnnouncementKey = (handleId: string, snapshotId: string) => `tars:announcement:${handleId}:${snapshotId}`
const rProblemsKey = "tars:problems:cache"
