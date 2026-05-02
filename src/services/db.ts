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

// ── Domain mappers ───────────────────────────────────────────────────────────
const rowToSubscription = (row: typeof channelSubscriptions.$inferSelect): ChannelSubscription => ({
  id: row.id,
  guildId: row.guildId,
  channelId: row.channelId,
  guildName: row.guildName ?? null,
  channelName: row.channelName ?? null,
  timezone: row.timezone,
  deliveryHour: row.deliveryHour,
  deliveryMinute: row.deliveryMinute,
  enabled: row.enabled ?? true,
  createdByUserId: row.createdByUserId,
  mentionRoleId: row.mentionRoleId ?? null,
  createdAt: new Date(row.createdAt),
  updatedAt: new Date(row.updatedAt),
})

const rowToTrackedHandle = (row: typeof trackedHandles.$inferSelect): TrackedHandle => ({
  id: row.id,
  guildId: row.guildId,
  platform: row.platform as TrackingPlatform,
  handle: row.handle,
  handleNormalized: row.handleNormalized,
  enabled: row.enabled ?? true,
  createdByUserId: row.createdByUserId,
  createdAt: new Date(row.createdAt),
  updatedAt: new Date(row.updatedAt),
})

const rowToSnapshot = (row: typeof ratingSnapshots.$inferSelect): RatingSnapshot => ({
  id: row.id,
  trackedHandleId: row.trackedHandleId,
  rating: row.rating ?? null,
  rankLabel: row.rankLabel ?? null,
  maxRating: row.maxRating ?? null,
  isImprovement: row.isImprovement ?? false,
  capturedAt: new Date(row.capturedAt),
  rawPayloadJson: JSON.parse(row.rawPayloadJson),
})

const trackedHandleId = (guildId: string, platform: string, handleNormalized: string) =>
  `${guildId}:${platform}:${handleNormalized}`

const wrap = <A>(operation: string, task: () => Promise<A>): Effect.Effect<A, DbError> =>
  Effect.tryPromise({ try: task, catch: (cause) => new DbError({ operation, cause }) })

export const DbServiceLive = Layer.scoped(
  DbService,
  Effect.gen(function* () {
    const config = yield* AppConfig

    const client = yield* Effect.acquireRelease(
      Effect.tryPromise({
        try: async () => createClient({ url: config.tursoUrl, ...(config.tursoAuthToken ? { authToken: config.tursoAuthToken } : {}) }),
        catch: (cause) => new DbError({ operation: "createClient", cause }),
      }),
      (c) => Effect.sync(() => c.close())
    )
    const db = drizzle({ client })

    // migrate() checks __drizzle_migrations table first — no-op after first run
    yield* Effect.tryPromise({
      try: () => migrate(db, { migrationsFolder: "./src/db/migrations" }),
      catch: (cause) => new DbError({ operation: "migrate", cause }),
    })
    yield* Effect.logInfo("[db] migrations applied")

    const redis = yield* Effect.acquireRelease(
      Effect.tryPromise({
        try: async () => new Redis(config.redisUrl, { lazyConnect: false, maxRetriesPerRequest: null }),
        catch: (cause) => new DbError({ operation: "connectRedis", cause }),
      }),
      (r) => Effect.promise(() => r.quit()).pipe(Effect.catchAll(() => Effect.void))
    )

    yield* Effect.logInfo("[db] connected to SQLite and Redis")

    // ── Subscription cache helpers ───────────────────────────────────────────
    const cacheSubscription = async (sub: ChannelSubscription) => {
      await redis.set(rSubKey(sub.channelId), JSON.stringify({
        ...sub,
        createdAt: sub.createdAt.toISOString(),
        updatedAt: sub.updatedAt.toISOString(),
      }), "EX", 86400)
    }

    const bustSubscriptionCache = async (channelId: string) => {
      await redis.del(rSubKey(channelId))
      await redis.del(rSubIndexKey)
    }

    const readCachedSubscription = async (channelId: string): Promise<ChannelSubscription | null> => {
      const raw = await redis.get(rSubKey(channelId))
      if (!raw) return null
      const p = JSON.parse(raw) as ChannelSubscription & { createdAt: string; updatedAt: string }
      return { ...p, createdAt: new Date(p.createdAt), updatedAt: new Date(p.updatedAt) }
    }

    // ── Snapshot cache helpers ───────────────────────────────────────────────
    const cacheSnapshot = async (snap: RatingSnapshot) => {
      await redis.set(rSnapshotKey(snap.trackedHandleId), JSON.stringify({
        ...snap,
        capturedAt: snap.capturedAt.toISOString(),
        rawPayloadJson: JSON.stringify(snap.rawPayloadJson),
      }), "EX", 86400)
    }

    const bustSnapshotCache = async (trackedHandleId: string) => {
      await redis.del(rSnapshotKey(trackedHandleId))
    }

    return {
      // ── Subscriptions ──────────────────────────────────────────────────────
      upsertSubscription: (input) =>
        wrap("upsertSubscription", async () => {
          const now = new Date().toISOString()
          const existing = await db.select({
            createdByUserId: channelSubscriptions.createdByUserId,
            mentionRoleId: channelSubscriptions.mentionRoleId,
            createdAt: channelSubscriptions.createdAt,
          }).from(channelSubscriptions)
            .where(eq(channelSubscriptions.channelId, input.channelId)).get()
          const createdAt = existing?.createdAt ?? now
          await db.insert(channelSubscriptions).values({
            id: input.channelId,
            guildId: input.guildId,
            channelId: input.channelId,
            guildName: input.guildName,
            channelName: input.channelName,
            timezone: input.timezone,
            deliveryHour: input.deliveryHour,
            deliveryMinute: input.deliveryMinute,
            enabled: true,
            createdByUserId: existing?.createdByUserId ?? input.createdByUserId,
            mentionRoleId: existing?.mentionRoleId ?? null,
            createdAt,
            updatedAt: now,
          }).onConflictDoUpdate({
            target: channelSubscriptions.channelId,
            set: {
              guildName: input.guildName,
              channelName: input.channelName,
              timezone: input.timezone,
              deliveryHour: input.deliveryHour,
              deliveryMinute: input.deliveryMinute,
              enabled: true,
              updatedAt: now,
            },
          })
          const sub: ChannelSubscription = {
            id: input.channelId,
            guildId: input.guildId,
            channelId: input.channelId,
            guildName: input.guildName,
            channelName: input.channelName,
            timezone: input.timezone,
            deliveryHour: input.deliveryHour,
            deliveryMinute: input.deliveryMinute,
            enabled: true,
            createdByUserId: existing?.createdByUserId ?? input.createdByUserId,
            mentionRoleId: existing?.mentionRoleId ?? null,
            createdAt: new Date(createdAt),
            updatedAt: new Date(now),
          }
          // cache ops fire-and-forget — don't block the response
          bustSubscriptionCache(input.channelId).then(() => cacheSubscription(sub)).catch(() => {})
          console.log(`[db] upsertSubscription channel=${input.channelId} guild=${input.guildId}`)
          return sub
        }),

      getSubscriptionByChannel: (channelId) =>
        wrap("getSubscriptionByChannel", async () => {
          const cached = await readCachedSubscription(channelId)
          if (cached) {
            console.debug(`[db] getSubscriptionByChannel cache=hit channel=${channelId}`)
            return cached
          }
          const row = await db.select().from(channelSubscriptions)
            .where(eq(channelSubscriptions.channelId, channelId)).get()
          if (!row) return null
          const sub = rowToSubscription(row)
          await cacheSubscription(sub)
          console.debug(`[db] getSubscriptionByChannel cache=miss channel=${channelId}`)
          return sub
        }),

      disableSubscription: (channelId) =>
        wrap("disableSubscription", async () => {
          const row = await db.select().from(channelSubscriptions)
            .where(eq(channelSubscriptions.channelId, channelId)).get()
          if (!row) return false
          await db.update(channelSubscriptions)
            .set({ enabled: false, updatedAt: new Date().toISOString() })
            .where(eq(channelSubscriptions.channelId, channelId))
          bustSubscriptionCache(channelId).catch(() => {})
          console.log(`[db] disableSubscription channel=${channelId}`)
          return true
        }),

