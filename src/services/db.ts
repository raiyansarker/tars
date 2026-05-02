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

      updateSubscriptionTimeZone: (channelId, timezone) =>
        wrap("updateSubscriptionTimeZone", async () => {
          const row = await db.select().from(channelSubscriptions)
            .where(eq(channelSubscriptions.channelId, channelId)).get()
          if (!row) return null
          const now = new Date().toISOString()
          await db.update(channelSubscriptions)
            .set({ timezone, updatedAt: now })
            .where(eq(channelSubscriptions.channelId, channelId))
          const updated = rowToSubscription({ ...row, timezone, updatedAt: now })
          bustSubscriptionCache(channelId).then(() => cacheSubscription(updated)).catch(() => {})
          console.log(`[db] updateSubscriptionTimeZone channel=${channelId} tz=${timezone}`)
          return updated
        }),

      updateSubscriptionDeliveryTime: (channelId, hour, minute) =>
        wrap("updateSubscriptionDeliveryTime", async () => {
          const row = await db.select().from(channelSubscriptions)
            .where(eq(channelSubscriptions.channelId, channelId)).get()
          if (!row) return null
          const now = new Date().toISOString()
          await db.update(channelSubscriptions)
            .set({ deliveryHour: hour, deliveryMinute: minute, updatedAt: now })
            .where(eq(channelSubscriptions.channelId, channelId))
          const updated = rowToSubscription({ ...row, deliveryHour: hour, deliveryMinute: minute, updatedAt: now })
          bustSubscriptionCache(channelId).then(() => cacheSubscription(updated)).catch(() => {})
          console.log(`[db] updateSubscriptionDeliveryTime channel=${channelId} time=${hour}:${minute}`)
          return updated
        }),

      updateSubscriptionMentionRole: (channelId, roleId) =>
        wrap("updateSubscriptionMentionRole", async () => {
          const row = await db.select().from(channelSubscriptions)
            .where(eq(channelSubscriptions.channelId, channelId)).get()
          if (!row) return null
          const now = new Date().toISOString()
          await db.update(channelSubscriptions)
            .set({ mentionRoleId: roleId, updatedAt: now })
            .where(eq(channelSubscriptions.channelId, channelId))
          const updated = rowToSubscription({ ...row, mentionRoleId: roleId, updatedAt: now })
          bustSubscriptionCache(channelId).then(() => cacheSubscription(updated)).catch(() => {})
          console.log(`[db] updateSubscriptionMentionRole channel=${channelId} role=${roleId}`)
          return updated
        }),

      listEnabledSubscriptions: wrap("listEnabledSubscriptions", async () => {
        const cached = await redis.get(rSubIndexKey)
        if (cached) {
          console.debug("[db] listEnabledSubscriptions cache=hit")
          const parsed = JSON.parse(cached) as Array<ChannelSubscription & { createdAt: string; updatedAt: string }>
          return parsed.map((p) => ({ ...p, createdAt: new Date(p.createdAt), updatedAt: new Date(p.updatedAt) }))
        }
        const rows = await db.select().from(channelSubscriptions)
          .where(eq(channelSubscriptions.enabled, true))
        const subs = rows.map(rowToSubscription)
        await redis.set(rSubIndexKey, JSON.stringify(subs.map((s) => ({
          ...s,
          createdAt: s.createdAt.toISOString(),
          updatedAt: s.updatedAt.toISOString(),
        }))), "EX", 86400)
        console.debug(`[db] listEnabledSubscriptions cache=miss count=${subs.length}`)
        return subs
      }),

      // ── Tracked handles ────────────────────────────────────────────────────
      addTrackedHandle: (guildId, platform, handle, handleNormalized, createdByUserId) =>
        wrap("addTrackedHandle", async () => {
          const id = trackedHandleId(guildId, platform, handleNormalized)
          const now = new Date().toISOString()
          const existing = await db.select().from(trackedHandles).where(eq(trackedHandles.id, id)).get()
          await db.insert(trackedHandles).values({
            id, guildId, platform, handle, handleNormalized, enabled: true,
            createdByUserId: existing?.createdByUserId ?? createdByUserId,
            createdAt: existing?.createdAt ?? now, updatedAt: now,
          }).onConflictDoUpdate({
            target: trackedHandles.id,
            set: { handle, enabled: true, updatedAt: now },
          })
          const row = await db.select().from(trackedHandles).where(eq(trackedHandles.id, id)).get()
          console.log(`[db] addTrackedHandle guild=${guildId} platform=${platform} handle=${handle}`)
          return rowToTrackedHandle(row!)
        }),

      removeTrackedHandle: (guildId, platform, handleNormalized) =>
        wrap("removeTrackedHandle", async () => {
          const id = trackedHandleId(guildId, platform, handleNormalized)
          const row = await db.select().from(trackedHandles).where(eq(trackedHandles.id, id)).get()
          if (!row || !row.enabled) return false
          await db.update(trackedHandles)
            .set({ enabled: false, updatedAt: new Date().toISOString() })
            .where(eq(trackedHandles.id, id))
          console.log(`[db] removeTrackedHandle guild=${guildId} platform=${platform} handle=${handleNormalized}`)
          return true
        }),

      getTrackedHandleByGuild: (guildId, platform, handleNormalized) =>
        wrap("getTrackedHandleByGuild", async () => {
          const id = trackedHandleId(guildId, platform, handleNormalized)
          const row = await db.select().from(trackedHandles)
            .where(and(eq(trackedHandles.id, id), eq(trackedHandles.enabled, true))).get()
          return row ? rowToTrackedHandle(row) : null
        }),

      listTrackedHandlesByGuild: (guildId) =>
        wrap("listTrackedHandlesByGuild", async () => {
          const rows = await db.select().from(trackedHandles)
            .where(and(eq(trackedHandles.guildId, guildId), eq(trackedHandles.enabled, true)))
          return rows.map(rowToTrackedHandle)
        }),

      listSchedulerTrackedHandles: wrap("listSchedulerTrackedHandles", async () => {
        const handles = await db.select().from(trackedHandles)
          .where(eq(trackedHandles.enabled, true))
        const subs = await db.select().from(channelSubscriptions)
          .where(eq(channelSubscriptions.enabled, true))
        const subsByGuild = new Map<string, typeof subs>()
        for (const s of subs) {
          const arr = subsByGuild.get(s.guildId) ?? []
          arr.push(s)
          subsByGuild.set(s.guildId, arr)
        }
        const result: SchedulerTrackedHandle[] = []
        for (const h of handles) {
          const guildSubs = subsByGuild.get(h.guildId)
          if (!guildSubs) continue
          for (const sub of guildSubs) {
            result.push({
              ...rowToSubscription(sub),
              trackedHandleId: h.id,
              platform: h.platform as TrackingPlatform,
              handle: h.handle,
              handleNormalized: h.handleNormalized,
              handleCreatedByUserId: h.createdByUserId,
            })
          }
        }
        console.debug(`[db] listSchedulerTrackedHandles count=${result.length}`)
        return result
      }),

      // ── Rating snapshots ───────────────────────────────────────────────────
      insertRatingSnapshot: (input) =>
        wrap("insertRatingSnapshot", async () => {
          const snap: RatingSnapshot = {
            id: crypto.randomUUID(),
            trackedHandleId: input.trackedHandleId,
            rating: input.rating,
            rankLabel: input.rankLabel,
            maxRating: input.maxRating,
            isImprovement: input.isImprovement,
            capturedAt: new Date(),
            rawPayloadJson: input.rawPayloadJson,
          }
          await db.insert(ratingSnapshots).values({
            id: snap.id,
            trackedHandleId: snap.trackedHandleId,
            rating: snap.rating,
            rankLabel: snap.rankLabel,
            maxRating: snap.maxRating,
            isImprovement: snap.isImprovement,
            capturedAt: snap.capturedAt.toISOString(),
            rawPayloadJson: JSON.stringify(snap.rawPayloadJson),
          })
          await bustSnapshotCache(input.trackedHandleId)
          await cacheSnapshot(snap)
          console.log(`[db] insertRatingSnapshot handle=${input.trackedHandleId} rating=${input.rating} improvement=${input.isImprovement}`)
          return snap
        }),

      getLatestRatingSnapshot: (trackedHandleId) =>
        wrap("getLatestRatingSnapshot", async () => {
          const cached = await redis.get(rSnapshotKey(trackedHandleId))
          if (cached) {
            console.debug(`[db] getLatestRatingSnapshot cache=hit handle=${trackedHandleId}`)
            const p = JSON.parse(cached) as RatingSnapshot & { capturedAt: string; rawPayloadJson: string }
            return { ...p, capturedAt: new Date(p.capturedAt), rawPayloadJson: JSON.parse(p.rawPayloadJson) }
          }
          const row = await db.select().from(ratingSnapshots)
            .where(eq(ratingSnapshots.trackedHandleId, trackedHandleId))
            .orderBy(desc(ratingSnapshots.capturedAt)).limit(1).get()
          if (!row) return null
          const snap = rowToSnapshot(row)
          await cacheSnapshot(snap)
          console.debug(`[db] getLatestRatingSnapshot cache=miss handle=${trackedHandleId}`)
          return snap
        }),

      countImprovementSnapshots: (guildId, platform, handleNormalized) =>
        wrap("countImprovementSnapshots", async () => {
          const id = trackedHandleId(guildId, platform, handleNormalized)
          const result = await db.select({ n: count() }).from(ratingSnapshots)
            .where(and(eq(ratingSnapshots.trackedHandleId, id), eq(ratingSnapshots.isImprovement, true))).get()
          return result?.n ?? 0
        }),

      getLeaderboard: (guildId) =>
        wrap("getLeaderboard", async () => {
          const rows = await db
            .select({
              handle: trackedHandles.handle,
              platform: trackedHandles.platform,
              rating: ratingSnapshots.rating,
              rankLabel: ratingSnapshots.rankLabel,
            })
            .from(trackedHandles)
            .innerJoin(ratingSnapshots, eq(ratingSnapshots.trackedHandleId, trackedHandles.id))
            .where(and(
              eq(trackedHandles.guildId, guildId),
              eq(trackedHandles.enabled, true),
              eq(trackedHandles.platform, "codeforces"),
              eq(
                ratingSnapshots.capturedAt,
                db.select({ m: sql<string>`MAX(${ratingSnapshots.capturedAt})` })
                  .from(ratingSnapshots)
                  .where(eq(ratingSnapshots.trackedHandleId, trackedHandles.id))
              )
            ))
            .orderBy(desc(ratingSnapshots.rating))
            .limit(10)
          return rows.map((r) => ({
            handle: r.handle,
            platform: r.platform as TrackingPlatform,
            rating: r.rating ?? null,
            rankLabel: r.rankLabel ?? null,
          }))
        }),

      // ── Command channels ───────────────────────────────────────────────────
      addCommandChannel: (guildId, channelId) =>
        wrap("addCommandChannel", async () => {
          await db.insert(commandChannels).values({ guildId, channelId })
            .onConflictDoNothing()
          console.log(`[db] addCommandChannel guild=${guildId} channel=${channelId}`)
        }),

      removeCommandChannel: (guildId, channelId) =>
        wrap("removeCommandChannel", async () => {
          const row = await db.select().from(commandChannels)
            .where(and(eq(commandChannels.guildId, guildId), eq(commandChannels.channelId, channelId))).get()
          if (!row) return false
          await db.delete(commandChannels)
            .where(and(eq(commandChannels.guildId, guildId), eq(commandChannels.channelId, channelId)))
          console.log(`[db] removeCommandChannel guild=${guildId} channel=${channelId}`)
          return true
        }),

      listCommandChannels: (guildId) =>
        wrap("listCommandChannels", async () => {
          const rows = await db.select().from(commandChannels)
            .where(eq(commandChannels.guildId, guildId))
          return rows.map((r) => r.channelId)
        }),

      // ── Redis claims ───────────────────────────────────────────────────────
      claimDigestDelivery: (channelSubscriptionId, targetDateKey) =>
        wrap("claimDigestDelivery", async () => {
          const key = rDeliveryKey(channelSubscriptionId, targetDateKey)
          const result = await redis.set(key, JSON.stringify({ status: "processing", claimedAt: new Date().toISOString() }), "EX", CLAIM_TTL, "NX")
          const claimed = result === "OK"
          console.debug(`[db] claimDigestDelivery channel=${channelSubscriptionId} date=${targetDateKey} claimed=${claimed}`)
          return claimed
        }),

      completeDigestDelivery: (channelSubscriptionId, targetDateKey, messageId) =>
        wrap("completeDigestDelivery", async () => {
          await redis.set(rDeliveryKey(channelSubscriptionId, targetDateKey),
            JSON.stringify({ status: "sent", sentAt: new Date().toISOString(), messageId }))
          console.log(`[db] completeDigestDelivery channel=${channelSubscriptionId} date=${targetDateKey} messageId=${messageId}`)
        }),

      releaseDigestDeliveryClaim: (channelSubscriptionId, targetDateKey) =>
        wrap("releaseDigestDeliveryClaim", async () => {
          await redis.del(rDeliveryKey(channelSubscriptionId, targetDateKey))
          console.warn(`[db] releaseDigestDeliveryClaim channel=${channelSubscriptionId} date=${targetDateKey}`)
        }),

      claimTrackingAnnouncement: (trackedHandleId, ratingSnapshotId) =>
        wrap("claimTrackingAnnouncement", async () => {
          const result = await redis.set(rAnnouncementKey(trackedHandleId, ratingSnapshotId),
            JSON.stringify({ status: "processing", claimedAt: new Date().toISOString() }), "EX", CLAIM_TTL, "NX")
          const claimed = result === "OK"
          console.debug(`[db] claimTrackingAnnouncement handle=${trackedHandleId} snapshot=${ratingSnapshotId} claimed=${claimed}`)
          return claimed
        }),

      completeTrackingAnnouncement: (trackedHandleId, ratingSnapshotId, channelSubscriptionId, messageId) =>
        wrap("completeTrackingAnnouncement", async () => {
          await redis.set(rAnnouncementKey(trackedHandleId, ratingSnapshotId),
            JSON.stringify({ status: "sent", channelSubscriptionId, messageId, announcedAt: new Date().toISOString() }))
          console.log(`[db] completeTrackingAnnouncement handle=${trackedHandleId} snapshot=${ratingSnapshotId}`)
        }),

      releaseTrackingAnnouncementClaim: (trackedHandleId, ratingSnapshotId) =>
        wrap("releaseTrackingAnnouncementClaim", async () => {
          await redis.del(rAnnouncementKey(trackedHandleId, ratingSnapshotId))
          console.warn(`[db] releaseTrackingAnnouncementClaim handle=${trackedHandleId} snapshot=${ratingSnapshotId}`)
        }),

      // ── Problem cache ──────────────────────────────────────────────────────
      getCachedProblems: wrap("getCachedProblems", () => redis.get(rProblemsKey)),

      setCachedProblems: (json) =>
        wrap("setCachedProblems", async () => {
          await redis.set(rProblemsKey, json, "EX", 86400)
          console.log("[db] setCachedProblems updated problem cache")
        }),
    }
  })
)
