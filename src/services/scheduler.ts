import { Context, Duration, Effect, Layer, Either } from "effect"

import { AppConfig } from "../config"
import { type SchedulerTrackedHandle } from "../domain/bot-state"
import { ContestDigestService } from "./contest-digest"
import { DiscordBotService } from "./discord-bot"
import { ProfileSourceService } from "./profile-sources"
import { DbService } from "./db"
import { getTomorrowDateKey, isDigestDue } from "../lib/time"
import {
  isProfileImproved,
  isProfileUnchanged
} from "../lib/tracking"
import { buildTrackingAnnouncement } from "../lib/announcements"
import { generateMotivationalQuote } from "./no"

export interface SchedulerService {
  readonly run: Effect.Effect<never, never>
}

export const SchedulerService = Context.GenericTag<SchedulerService>("SchedulerService")

const profileMapKey = (trackedHandle: {
  readonly platform: string
  readonly handleNormalized: string
}): string => `${trackedHandle.platform}:${trackedHandle.handleNormalized}`

const describeError = (error: unknown): string => {
  if (typeof error !== "object" || error === null) {
    return String(error)
  }

  if ("reason" in error && typeof error.reason === "string") {
    return error.reason
  }

  if ("operation" in error && typeof error.operation === "string") {
    return error.operation
  }

  if ("message" in error && typeof error.message === "string") {
    return error.message
  }

  if ("_tag" in error && typeof error._tag === "string") {
    return error._tag
  }

  return String(error)
}

export const SchedulerServiceLive = Layer.effect(
  SchedulerService,
  Effect.gen(function* () {
    const config = yield* AppConfig
    const digestService = yield* ContestDigestService
    const bot = yield* DiscordBotService
    const store = yield* DbService
    const profileService = yield* ProfileSourceService

    const processDigests = (now: Date) =>
      Effect.gen(function* () {
        const subscriptions = yield* store.listEnabledSubscriptions

        for (const subscription of subscriptions) {
          const isDue = isDigestDue(
            now,
            subscription.timezone,
            subscription.deliveryHour,
            subscription.deliveryMinute
          )
          
          yield* Effect.logDebug(`Checking digest for ${subscription.channelId}: timezone=${subscription.timezone}, time=${subscription.deliveryHour}:${subscription.deliveryMinute}, isDue=${isDue}`)

          if (!isDue) {
            continue
          }

          const targetDateKey = getTomorrowDateKey(now, subscription.timezone)
          const claimed = yield* store.claimDigestDelivery(
            subscription.id,
            targetDateKey
          )
          if (!claimed) {
            continue
          }

          const delivery = digestService
            .getDigest("tomorrow", subscription.timezone, now)
            .pipe(
              Effect.flatMap((digest) =>
                bot.postChannelMessage(subscription.guildId, subscription.channelId,
                  subscription.mentionRoleId
                    ? `<@&${subscription.mentionRoleId}>\n${digest.message}`
                    : digest.message
                ).pipe(
                  Effect.flatMap((sent) =>
                    store.completeDigestDelivery(
                      subscription.id,
                      targetDateKey,
                      sent.messageId
                    )
                  )
                )
              )
            )

          yield* delivery.pipe(
            Effect.tap(() =>
              Effect.logInfo(
                `Sent digest to channel ${subscription.channelId} for ${targetDateKey}`
              )
            ),
            Effect.catchAll((error) =>
              store.releaseDigestDeliveryClaim(subscription.id, targetDateKey).pipe(
                  Effect.zipRight(
                    Effect.logError(
                      `Digest delivery failed for ${subscription.channelId}: ${describeError(error)}`
                    )
                  )
                )
            )
          )
        }
      })

    const processTracking = (now: Date) =>
      Effect.gen(function* () {
        const trackedHandles = yield* store.listSchedulerTrackedHandles
        if (trackedHandles.length === 0) {
          return
        }

        const uniqueTrackedHandles = [...new Map(
          trackedHandles.map((trackedHandle) => [profileMapKey(trackedHandle), trackedHandle])
        ).values()]

        const profileResults = yield* Effect.all(
          uniqueTrackedHandles.map((trackedHandle) =>
            profileService
              .fetchProfile(trackedHandle.platform, trackedHandle.handle)
              .pipe(Effect.either)
          ),
          { concurrency: 4 }
        )

        const profiles = new Map(
          uniqueTrackedHandles.map((trackedHandle, index) => [
            profileMapKey(trackedHandle),
            profileResults[index]
          ])
        )

        for (const trackedHandle of trackedHandles) {
          const profileResult = profiles.get(profileMapKey(trackedHandle))
          if (!profileResult || Either.isLeft(profileResult)) {
            yield* Effect.logWarning(
              `Tracking refresh failed for ${trackedHandle.platform}:${trackedHandle.handle}`
            )
            continue
          }

          const profile = profileResult.right
          const previousSnapshot = yield* store.getLatestRatingSnapshot(
            trackedHandle.trackedHandleId
          )

          if (isProfileUnchanged(previousSnapshot, profile)) {
            if (previousSnapshot?.isImprovement && profile.rating !== null) {
              const claimed = yield* store.claimTrackingAnnouncement(
                trackedHandle.trackedHandleId,
                previousSnapshot.id
              )

              if (!claimed) {
                continue
              }

              const retryMessage = buildTrackingAnnouncement(
                trackedHandle,
                profile.rating,
                profile.rankLabel
              )

              yield* bot.postChannelMessage(trackedHandle.guildId, trackedHandle.channelId, retryMessage).pipe(
                Effect.flatMap((sent) =>
                  store.completeTrackingAnnouncement(
                    trackedHandle.trackedHandleId,
                    previousSnapshot.id,
                    trackedHandle.id,
                    sent.messageId
                  )
                ),
                Effect.catchAll((error) =>
                  store
                    .releaseTrackingAnnouncementClaim(
                      trackedHandle.trackedHandleId,
                      previousSnapshot.id
                    )
                    .pipe(
                      Effect.zipRight(
                        Effect.logError(
                          `Retrying tracking announcement failed for ${trackedHandle.handle}: ${describeError(error)}`
                        )
                      )
                    )
                )
              )
            }

            continue
          }

          const improved = isProfileImproved(previousSnapshot, profile)
          const snapshot = yield* store.insertRatingSnapshot({
            trackedHandleId: trackedHandle.trackedHandleId,
            rating: profile.rating,
            rankLabel: profile.rankLabel,
            maxRating: profile.maxRating,
            isImprovement: improved,
            rawPayloadJson: profile.rawPayload
          })

          if (!improved || profile.rating === null) {
            continue
          }

          const claimed = yield* store.claimTrackingAnnouncement(
            trackedHandle.trackedHandleId,
            snapshot.id
          )
          if (!claimed) {
            continue
          }

          const delta = previousSnapshot?.rating != null ? profile.rating - previousSnapshot.rating : null
          const quote = yield* Effect.tryPromise({
            try: () => generateMotivationalQuote(
              config.groqApiKey,
              trackedHandle.handle,
              trackedHandle.platform,
              delta,
              profile.rating!,
              profile.rankLabel
            ),
            catch: () => null
          }).pipe(Effect.orElseSucceed(() => ""))
          const message = buildTrackingAnnouncement(
            trackedHandle,
            profile.rating,
            profile.rankLabel,
            previousSnapshot?.rating
          ) + (quote ? `\n\n*${quote}*` : "")

          yield* bot.postChannelMessage(trackedHandle.guildId, trackedHandle.channelId, message).pipe(
            Effect.flatMap((sent) =>
              store.completeTrackingAnnouncement(
                trackedHandle.trackedHandleId,
                snapshot.id,
                trackedHandle.id,
                sent.messageId
              )
            ),
            Effect.tap(() =>
              Effect.logInfo(
                `Announced tracking improvement for ${trackedHandle.handle}`
              )
            ),
            Effect.catchAll((error) =>
              store.releaseTrackingAnnouncementClaim(
                trackedHandle.trackedHandleId,
                snapshot.id
              ).pipe(
                Effect.zipRight(
                  Effect.logError(
                    `Tracking announcement failed for ${trackedHandle.handle}: ${describeError(error)}`
                  )
                )
              )
            )
          )
        }
      })

    const run = Effect.gen(function* () {
      while (true) {
        const now = new Date()
        yield* Effect.logInfo(`Scheduler tick at ${now.toISOString()}`)

        yield* processDigests(now).pipe(
          Effect.catchAll((error) =>
            Effect.logError(`Digest scheduler tick failed: ${describeError(error)}`)
          )
        )

        yield* processTracking(now).pipe(
          Effect.catchAll((error) =>
            Effect.logError(`Tracking scheduler tick failed: ${describeError(error)}`)
          )
        )

        yield* Effect.sleep(Duration.minutes(config.schedulerPollMinutes))
      }
    })

    return {
      run
    }
  })
)
