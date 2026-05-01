import { Context, Data, Effect, Layer } from "effect"
import Redis from "ioredis"

import { AppConfig } from "../config"
import type {
  ChannelSubscription,
  RatingSnapshot,
  SchedulerTrackedHandle,
  TrackedHandle,
  TrackingPlatform
} from "../domain/bot-state"

export class StateStoreError extends Data.TaggedError("StateStoreError")<{
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

export interface StateStoreService {
  readonly upsertSubscription: (
    input: UpsertSubscriptionInput
  ) => Effect.Effect<ChannelSubscription, StateStoreError>
  readonly getSubscriptionByChannel: (
    channelId: string
  ) => Effect.Effect<ChannelSubscription | null, StateStoreError>
  readonly disableSubscription: (
    channelId: string
  ) => Effect.Effect<boolean, StateStoreError>
  readonly updateSubscriptionTimeZone: (
    channelId: string,
    timezone: string
  ) => Effect.Effect<ChannelSubscription | null, StateStoreError>
  readonly updateSubscriptionDeliveryTime: (
    channelId: string,
    deliveryHour: number,
    deliveryMinute: number
  ) => Effect.Effect<ChannelSubscription | null, StateStoreError>
  readonly updateSubscriptionMentionRole: (
    channelId: string,
    mentionRoleId: string | null
  ) => Effect.Effect<ChannelSubscription | null, StateStoreError>
  readonly listEnabledSubscriptions: Effect.Effect<
    ReadonlyArray<ChannelSubscription>,
    StateStoreError
  >
  readonly claimDigestDelivery: (
    channelSubscriptionId: string,
    targetDateKey: string
  ) => Effect.Effect<boolean, StateStoreError>
  readonly completeDigestDelivery: (
    channelSubscriptionId: string,
    targetDateKey: string,
    messageId: string | null
  ) => Effect.Effect<void, StateStoreError>
  readonly releaseDigestDeliveryClaim: (
    channelSubscriptionId: string,
    targetDateKey: string
  ) => Effect.Effect<void, StateStoreError>
  readonly listTrackedHandlesByChannel: (
    channelId: string
  ) => Effect.Effect<ReadonlyArray<TrackedHandle>, StateStoreError>
  readonly addTrackedHandle: (
    channelId: string,
    platform: TrackingPlatform,
    handle: string,
    handleNormalized: string,
    createdByUserId: string
  ) => Effect.Effect<TrackedHandle | null, StateStoreError>
  readonly removeTrackedHandle: (
    channelId: string,
    platform: TrackingPlatform,
    handleNormalized: string
  ) => Effect.Effect<boolean, StateStoreError>
  readonly getTrackedHandleByChannel: (
    channelId: string,
    platform: TrackingPlatform,
    handleNormalized: string
  ) => Effect.Effect<TrackedHandle | null, StateStoreError>
  readonly listSchedulerTrackedHandles: Effect.Effect<
    ReadonlyArray<SchedulerTrackedHandle>,
    StateStoreError
  >
  readonly getLatestRatingSnapshot: (
    trackedHandleId: string
  ) => Effect.Effect<RatingSnapshot | null, StateStoreError>
  readonly insertRatingSnapshot: (
    input: InsertRatingSnapshotInput
  ) => Effect.Effect<RatingSnapshot, StateStoreError>
  readonly claimTrackingAnnouncement: (
    trackedHandleId: string,
    ratingSnapshotId: string,
  ) => Effect.Effect<boolean, StateStoreError>
  readonly completeTrackingAnnouncement: (
    trackedHandleId: string,
    ratingSnapshotId: string,
    channelSubscriptionId: string,
    messageId: string | null
  ) => Effect.Effect<void, StateStoreError>
  readonly releaseTrackingAnnouncementClaim: (
    trackedHandleId: string,
    ratingSnapshotId: string
  ) => Effect.Effect<void, StateStoreError>
  readonly countImprovementSnapshots: (
    channelId: string,
    platform: TrackingPlatform,
    handleNormalized: string
  ) => Effect.Effect<number, StateStoreError>
  readonly getLeaderboard: (
    channelId: string
  ) => Effect.Effect<
    ReadonlyArray<{
      readonly handle: string
      readonly platform: TrackingPlatform
      readonly rating: number | null
      readonly rankLabel: string | null
    }>,
    StateStoreError
  >
}

export const StateStoreService =
  Context.GenericTag<StateStoreService>("StateStoreService")

const prefix = "tars"
const subscriptionIndexKey = `${prefix}:subscriptions:index`
const trackedIndexKey = `${prefix}:tracked:index`
const claimTtlSeconds = 60 * 20

const wrapRedisPromise = <A>(
  operation: string,
  task: () => Promise<A>
): Effect.Effect<A, StateStoreError> =>
  Effect.tryPromise({
    try: task,
    catch: (cause) =>
      new StateStoreError({
        operation,
        cause
      })
  })

const subscriptionKey = (channelId: string): string =>
  `${prefix}:subscription:${channelId}`

const deliveryKey = (channelId: string, targetDateKey: string): string =>
  `${prefix}:delivery:${channelId}:${targetDateKey}`

const trackedHandleIdFor = (
  channelId: string,
  platform: TrackingPlatform,
  handleNormalized: string
): string => `${channelId}:${platform}:${handleNormalized}`

const trackedSetKey = (channelId: string): string =>
  `${prefix}:tracked:channel:${channelId}`

const trackedMetaKey = (trackedHandleId: string): string =>
  `${prefix}:tracked:meta:${trackedHandleId}`

const latestSnapshotKey = (trackedHandleId: string): string =>
  `${prefix}:snapshot:latest:${trackedHandleId}`

const snapshotHistoryKey = (trackedHandleId: string): string =>
  `${prefix}:snapshot:history:${trackedHandleId}`

const improvementCountKey = (trackedHandleId: string): string =>
  `${prefix}:snapshot:improvement-count:${trackedHandleId}`

const announcementKey = (trackedHandleId: string, ratingSnapshotId: string): string =>
  `${prefix}:announcement:${trackedHandleId}:${ratingSnapshotId}`

const toNullable = (value: string | null | undefined): string | null =>
  value === undefined || value === "" ? null : value

const toRequiredString = (
  record: Record<string, string>,
  key: string
): string | null => {
  const value = record[key]
  return value === undefined || value === "" ? null : value
}

const toRequiredInteger = (
  record: Record<string, string>,
  key: string
): number | null => {
  const value = toRequiredString(record, key)
  if (value === null) {
    return null
  }

  const parsed = Number(value)
  return Number.isInteger(parsed) ? parsed : null
}

const toRequiredDate = (
  record: Record<string, string>,
  key: string
): Date | null => {
  const value = toRequiredString(record, key)
  if (value === null) {
    return null
  }

  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : date
}

const isTrackingPlatform = (value: string): value is TrackingPlatform =>
  value === "codeforces" || value === "atcoder"

const mapSubscriptionRecord = (
  record: Record<string, string>,
  channelId: string
): ChannelSubscription | null => {
  const guildId = toRequiredString(record, "guildId")
  const timezone = toRequiredString(record, "timezone")
  const deliveryHour = toRequiredInteger(record, "deliveryHour")
  const deliveryMinute = toRequiredInteger(record, "deliveryMinute")
  const createdByUserId = toRequiredString(record, "createdByUserId")
  const createdAt = toRequiredDate(record, "createdAt")
  const updatedAt = toRequiredDate(record, "updatedAt")

  if (
    guildId === null ||
    timezone === null ||
    deliveryHour === null ||
    deliveryMinute === null ||
    createdByUserId === null ||
    createdAt === null ||
    updatedAt === null
  ) {
    return null
  }

  return {
    id: channelId,
    guildId,
    channelId,
    guildName: toNullable(record.guildName),
    channelName: toNullable(record.channelName),
    timezone,
    deliveryHour,
    deliveryMinute,
    enabled: record.enabled === "true",
    createdByUserId,
    mentionRoleId: toNullable(record.mentionRoleId),
    createdAt,
    updatedAt
  }
}

const mapTrackedHandleRecord = (
  trackedHandleId: string,
  record: Record<string, string>
): TrackedHandle | null => {
  const channelId = toRequiredString(record, "channelId")
  const platform = toRequiredString(record, "platform")
  const handle = toRequiredString(record, "handle")
  const handleNormalized = toRequiredString(record, "handleNormalized")
  const createdByUserId = toRequiredString(record, "createdByUserId")
  const createdAt = toRequiredDate(record, "createdAt")
  const updatedAt = toRequiredDate(record, "updatedAt")

  if (
    channelId === null ||
    platform === null ||
    !isTrackingPlatform(platform) ||
    handle === null ||
    handleNormalized === null ||
    createdByUserId === null ||
    createdAt === null ||
    updatedAt === null
  ) {
    return null
  }

  return {
    id: trackedHandleId,
    channelSubscriptionId: channelId,
    platform,
    handle,
    handleNormalized,
    enabled: record.enabled === "true",
    createdByUserId,
    createdAt,
    updatedAt
  }
}

const parseSnapshot = (payload: string | null): RatingSnapshot | null => {
  if (!payload) {
    return null
  }

  const parsed = JSON.parse(payload) as {
    id: string
    trackedHandleId: string
    rating: number | null
    rankLabel: string | null
    maxRating: number | null
    isImprovement: boolean
    capturedAt: string
    rawPayloadJson: unknown
  }

  return {
    ...parsed,
    capturedAt: new Date(parsed.capturedAt)
  }
}

export const StateStoreServiceLive = Layer.scoped(
  StateStoreService,
  Effect.gen(function* () {
    const config = yield* AppConfig

    const client = yield* Effect.acquireRelease(
      Effect.tryPromise({
        try: async () => new Redis(config.redisUrl, { lazyConnect: false, maxRetriesPerRequest: null }),
        catch: (cause) => new StateStoreError({ operation: "connectRedis", cause })
      }),
      (redis) =>
        Effect.tryPromise({
          try: () => redis.quit(),
          catch: () => undefined
        }).pipe(Effect.catchAll(() => Effect.void))
    )

    const readSubscription = async (
      channelId: string
    ): Promise<ChannelSubscription | null> =>
      mapSubscriptionRecord(await client.hgetall(subscriptionKey(channelId)), channelId)

    const readTrackedHandle = async (
      trackedHandleId: string
    ): Promise<TrackedHandle | null> =>
      mapTrackedHandleRecord(
        trackedHandleId,
        await client.hgetall(trackedMetaKey(trackedHandleId))
      )

    return {
      upsertSubscription: (input) =>
        wrapRedisPromise("upsertSubscription", async () => {
          const key = subscriptionKey(input.channelId)
          const existing = await readSubscription(input.channelId)
          const createdAt = existing?.createdAt.toISOString() ?? new Date().toISOString()
          const updatedAt = new Date().toISOString()

          await client.sadd(subscriptionIndexKey, input.channelId)
          await client.hset(key, {
            guildId: input.guildId,
            guildName: input.guildName ?? "",
            channelName: input.channelName ?? "",
            timezone: input.timezone,
            deliveryHour: String(input.deliveryHour),
            deliveryMinute: String(input.deliveryMinute),
            enabled: "true",
            createdByUserId: existing?.createdByUserId ?? input.createdByUserId,
            mentionRoleId: existing?.mentionRoleId ?? "",
            createdAt,
            updatedAt
          })

          return (await readSubscription(input.channelId))!
        }),
      getSubscriptionByChannel: (channelId) =>
        wrapRedisPromise("getSubscriptionByChannel", () =>
          readSubscription(channelId)
        ),
      disableSubscription: (channelId) =>
        wrapRedisPromise("disableSubscription", async () => {
          const current = await readSubscription(channelId)
          if (!current) {
            return false
          }

          await client.hset(subscriptionKey(channelId), {
            enabled: "false",
            updatedAt: new Date().toISOString()
          })
          return true
        }),
      updateSubscriptionTimeZone: (channelId, timezone) =>
        wrapRedisPromise("updateSubscriptionTimeZone", async () => {
          const current = await readSubscription(channelId)
          if (!current) {
            return null
          }

          await client.hset(subscriptionKey(channelId), {
            timezone,
            updatedAt: new Date().toISOString()
          })
          return readSubscription(channelId)
        }),
      updateSubscriptionDeliveryTime: (channelId, deliveryHour, deliveryMinute) =>
        wrapRedisPromise("updateSubscriptionDeliveryTime", async () => {
          const current = await readSubscription(channelId)
          if (!current) {
            return null
          }

          await client.hset(subscriptionKey(channelId), {
            deliveryHour: String(deliveryHour),
            deliveryMinute: String(deliveryMinute),
            updatedAt: new Date().toISOString()
          })
          return readSubscription(channelId)
        }),
      updateSubscriptionMentionRole: (channelId, mentionRoleId) =>
        wrapRedisPromise("updateSubscriptionMentionRole", async () => {
          const current = await readSubscription(channelId)
          if (!current) return null
          await client.hset(subscriptionKey(channelId), {
            mentionRoleId: mentionRoleId ?? "",
            updatedAt: new Date().toISOString()
          })
          return readSubscription(channelId)
        }),
      listEnabledSubscriptions: wrapRedisPromise(
        "listEnabledSubscriptions",
        async () => {
          const channelIds = await client.smembers(subscriptionIndexKey)
          const subscriptions = await Promise.all(
            channelIds.map((channelId) => readSubscription(channelId))
          )

          return subscriptions.filter(
            (subscription): subscription is ChannelSubscription =>
              subscription !== null && subscription.enabled
          )
        }
      ),
      claimDigestDelivery: (channelSubscriptionId, targetDateKey) =>
        wrapRedisPromise("claimDigestDelivery", async () => {
          const key = deliveryKey(channelSubscriptionId, targetDateKey)
          const claimed = await client.set(
            key,
            JSON.stringify({
              status: "processing",
              claimedAt: new Date().toISOString(),
              messageId: null
            }), 'EX', claimTtlSeconds, 'NX'
          )

          return claimed === "OK"
        }),
      completeDigestDelivery: (channelSubscriptionId, targetDateKey, messageId) =>
        wrapRedisPromise("completeDigestDelivery", async () => {
          await client.set(
            deliveryKey(channelSubscriptionId, targetDateKey),
            JSON.stringify({
              status: "sent",
              sentAt: new Date().toISOString(),
              messageId
            })
          )
        }),
      releaseDigestDeliveryClaim: (channelSubscriptionId, targetDateKey) =>
        wrapRedisPromise("releaseDigestDeliveryClaim", async () => {
          await client.del(deliveryKey(channelSubscriptionId, targetDateKey))
        }),
      listTrackedHandlesByChannel: (channelId) =>
        wrapRedisPromise("listTrackedHandlesByChannel", async () => {
          const trackedIds = await client.smembers(trackedSetKey(channelId))
          const trackedHandles = await Promise.all(
            trackedIds.map((trackedHandleId) => readTrackedHandle(trackedHandleId))
          )

          return trackedHandles.filter(
            (trackedHandle): trackedHandle is TrackedHandle =>
              trackedHandle !== null && trackedHandle.enabled
          )
        }),
      addTrackedHandle: (
        channelId,
        platform,
        handle,
        handleNormalized,
        createdByUserId
      ) =>
        wrapRedisPromise("addTrackedHandle", async () => {
          const subscription = await readSubscription(channelId)
          if (!subscription || !subscription.enabled) {
            return null
          }

          const trackedHandleId = trackedHandleIdFor(channelId, platform, handleNormalized)
          const existing = await readTrackedHandle(trackedHandleId)
          const createdAt = existing?.createdAt.toISOString() ?? new Date().toISOString()
          const updatedAt = new Date().toISOString()

          await client.sadd(trackedSetKey(channelId), trackedHandleId)
          await client.sadd(trackedIndexKey, trackedHandleId)
          await client.hset(trackedMetaKey(trackedHandleId), {
            channelId,
            platform,
            handle,
            handleNormalized,
            enabled: "true",
            createdByUserId: existing?.createdByUserId ?? createdByUserId,
            createdAt,
            updatedAt
          })

          return readTrackedHandle(trackedHandleId)
        }),
      removeTrackedHandle: (channelId, platform, handleNormalized) =>
        wrapRedisPromise("removeTrackedHandle", async () => {
          const trackedHandleId = trackedHandleIdFor(channelId, platform, handleNormalized)
          const trackedHandle = await readTrackedHandle(trackedHandleId)

          if (!trackedHandle) {
            return false
          }

          await client.hset(trackedMetaKey(trackedHandleId), {
            enabled: "false",
            updatedAt: new Date().toISOString()
          })
          return true
        }),
      getTrackedHandleByChannel: (channelId, platform, handleNormalized) =>
        wrapRedisPromise("getTrackedHandleByChannel", async () => {
          const trackedHandleId = trackedHandleIdFor(channelId, platform, handleNormalized)
          const trackedHandle = await readTrackedHandle(trackedHandleId)

          return trackedHandle && trackedHandle.enabled ? trackedHandle : null
        }),
      listSchedulerTrackedHandles: wrapRedisPromise(
        "listSchedulerTrackedHandles",
        async () => {
          const trackedIds = await client.smembers(trackedIndexKey)
          const rows = await Promise.all(
            trackedIds.map(async (trackedHandleId) => {
              const tracked = await readTrackedHandle(trackedHandleId)

              if (!tracked || !tracked.enabled) {
                return null
              }

              const subscription = await readSubscription(tracked.channelSubscriptionId)
              if (!subscription || !subscription.enabled) {
                return null
              }

              return {
                ...subscription,
                trackedHandleId: tracked.id,
                platform: tracked.platform,
                handle: tracked.handle,
                handleNormalized: tracked.handleNormalized,
                handleCreatedByUserId: tracked.createdByUserId
              } satisfies SchedulerTrackedHandle
            })
          )

          return rows.filter(
            (row): row is SchedulerTrackedHandle => row !== null
          )
        }
      ),
      getLatestRatingSnapshot: (trackedHandleId) =>
        wrapRedisPromise("getLatestRatingSnapshot", async () =>
          parseSnapshot(await client.get(latestSnapshotKey(trackedHandleId)))
        ),
      insertRatingSnapshot: (input) =>
        wrapRedisPromise("insertRatingSnapshot", async () => {
          const snapshot: RatingSnapshot = {
            id: crypto.randomUUID(),
            trackedHandleId: input.trackedHandleId,
            rating: input.rating,
            rankLabel: input.rankLabel,
            maxRating: input.maxRating,
            isImprovement: input.isImprovement,
            capturedAt: new Date(),
            rawPayloadJson: input.rawPayloadJson
          }
          const payload = JSON.stringify({
            ...snapshot,
            capturedAt: snapshot.capturedAt.toISOString()
          })

          await client.set(latestSnapshotKey(input.trackedHandleId), payload)
          await client.lpush(snapshotHistoryKey(input.trackedHandleId), payload)
          await client.ltrim(snapshotHistoryKey(input.trackedHandleId), 0, 49)
          if (input.isImprovement) {
            await client.incr(improvementCountKey(input.trackedHandleId))
          }

          return snapshot
        }),
      claimTrackingAnnouncement: (trackedHandleId, ratingSnapshotId) =>
        wrapRedisPromise("claimTrackingAnnouncement", async () => {
          const created = await client.set(
            announcementKey(trackedHandleId, ratingSnapshotId),
            JSON.stringify({
              status: "processing",
              claimedAt: new Date().toISOString()
            }), 'EX', claimTtlSeconds, 'NX'
          )

          return created === "OK"
        }),
      completeTrackingAnnouncement: (
        trackedHandleId,
        ratingSnapshotId,
        channelSubscriptionId,
        messageId
      ) =>
        wrapRedisPromise("completeTrackingAnnouncement", async () => {
          await client.set(
            announcementKey(trackedHandleId, ratingSnapshotId),
            JSON.stringify({
              status: "sent",
              channelSubscriptionId,
              messageId,
              announcedAt: new Date().toISOString()
            })
          )
        }),
      releaseTrackingAnnouncementClaim: (trackedHandleId, ratingSnapshotId) =>
        wrapRedisPromise("releaseTrackingAnnouncementClaim", async () => {
          await client.del(announcementKey(trackedHandleId, ratingSnapshotId))
        }),
      countImprovementSnapshots: (channelId, platform, handleNormalized) =>
        wrapRedisPromise("countImprovementSnapshots", async () => {
          const trackedHandleId = trackedHandleIdFor(channelId, platform, handleNormalized)
          const count = await client.get(improvementCountKey(trackedHandleId))
          return Number(count ?? 0)
        }),
      getLeaderboard: (channelId) =>
        wrapRedisPromise("getLeaderboard", async () => {
          const trackedIds = await client.smembers(trackedSetKey(channelId))
          const results = await Promise.all(
            trackedIds.map(async (id) => {
              const [meta, snapshotRaw] = await Promise.all([
                client.hgetall(trackedMetaKey(id)),
                client.get(latestSnapshotKey(id))
              ])

              if (!meta.handle || meta.enabled === "false") return null

              const snapshot = parseSnapshot(snapshotRaw)
              return {
                handle: meta.handle,
                platform: meta.platform as TrackingPlatform,
                rating: snapshot?.rating ?? null,
                rankLabel: snapshot?.rankLabel ?? null
              }
            })
          )

          return results
            .filter((r): r is NonNullable<typeof r> => r !== null)
            .sort((a, b) => (b.rating ?? -1) - (a.rating ?? -1))
            .slice(0, 10)
        })
    }
  })
)
