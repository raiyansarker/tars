import {
  HttpClient,
  HttpClientResponse
} from "@effect/platform"
import { Context, Data, Effect, Layer, Schedule } from "effect"

import type { TrackedProfile, TrackingPlatform } from "../domain/bot-state"
import { normalizeHandle } from "../lib/tracking"

export class ProfileSourceError extends Data.TaggedError("ProfileSourceError")<{
  readonly platform: TrackingPlatform
  readonly handle: string
  readonly reason: string
  readonly cause?: unknown
}> {}

export interface ProfileSourceService {
  readonly fetchProfile: (
    platform: TrackingPlatform,
    handle: string
  ) => Effect.Effect<TrackedProfile, ProfileSourceError>
}

export const ProfileSourceService =
  Context.GenericTag<ProfileSourceService>("ProfileSourceService")

const retrySchedule = Schedule.exponential("250 millis").pipe(
  Schedule.jittered,
  Schedule.intersect(Schedule.recurs(2))
)

const atCoderRankLabel = (rating: number | null): string | null => {
  if (rating === null) {
    return "Unrated"
  }
  if (rating < 400) {
    return "Gray"
  }
  if (rating < 800) {
    return "Brown"
  }
  if (rating < 1200) {
    return "Green"
  }
  if (rating < 1600) {
    return "Cyan"
  }
  if (rating < 2000) {
    return "Blue"
  }
  if (rating < 2400) {
    return "Yellow"
  }
  if (rating < 2800) {
    return "Orange"
  }
  if (rating < 3200) {
    return "Red"
  }

  return "Red+"
}

const fetchCodeforcesProfile = (
  httpClient: HttpClient.HttpClient,
  handle: string
): Effect.Effect<TrackedProfile, ProfileSourceError> =>
  httpClient
    .get(
      `https://codeforces.com/api/user.info?handles=${encodeURIComponent(
        handle
      )}&checkHistoricHandles=true`
    )
    .pipe(
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.flatMap((response) => response.json),
      Effect.flatMap((payload) => {
        const record = payload as {
          status?: unknown
          result?: Array<Record<string, unknown>>
        }

        const user = record.result?.[0]
        if (record.status !== "OK" || !user) {
          return Effect.fail(
            new ProfileSourceError({
              platform: "codeforces",
              handle,
              reason: "Codeforces user was not found"
            })
          )
        }

        const canonicalHandle = String(user.handle ?? handle)
        const rating =
          user.rating === undefined || user.rating === null ? null : Number(user.rating)
        const maxRating =
          user.maxRating === undefined || user.maxRating === null
            ? null
            : Number(user.maxRating)
        const rankLabel =
          user.rank === undefined || user.rank === null ? "Unrated" : String(user.rank)

        return Effect.succeed<TrackedProfile>({
          platform: "codeforces",
          handle: canonicalHandle,
          handleNormalized: normalizeHandle(canonicalHandle),
          profileUrl: `https://codeforces.com/profile/${encodeURIComponent(canonicalHandle)}`,
          rating,
          rankLabel,
          maxRating,
          rawPayload: user
        }).pipe(
          Effect.tap(() =>
            Effect.logDebug(
              `Fetched Codeforces profile for ${canonicalHandle}: rating=${rating}, rank=${rankLabel}`
            )
          )
        )
      }),
      Effect.retry(retrySchedule),
      Effect.mapError((cause) =>
        cause instanceof ProfileSourceError
          ? cause
          : new ProfileSourceError({
              platform: "codeforces",
              handle,
              reason: "Failed to fetch Codeforces profile",
              cause
            })
      )
    )

const fetchAtCoderProfile = (
  httpClient: HttpClient.HttpClient,
  handle: string
): Effect.Effect<TrackedProfile, ProfileSourceError> =>
  httpClient
    .get(`https://atcoder.jp/users/${encodeURIComponent(handle)}/history/json`)
    .pipe(
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.flatMap((response) => response.json),
      Effect.flatMap((payload) => {
        const rows = Array.isArray(payload) ? payload : null
        if (!rows) {
          return Effect.fail(
            new ProfileSourceError({
              platform: "atcoder",
              handle,
              reason: "AtCoder returned an unexpected profile payload"
            })
          )
        }

        const ratedRows = rows.filter(
          (row): row is Record<string, unknown> =>
            Boolean(row) && typeof row === "object" && "NewRating" in row
        )
        const latest = ratedRows.at(-1)
        const ratings = ratedRows
          .map((row) => Number(row.NewRating))
          .filter((value) => Number.isFinite(value))
        const rating = latest ? Number(latest.NewRating) : null
        const maxRating =
          ratings.length > 0 ? Math.max(...ratings) : rating
        const rankLabel = atCoderRankLabel(rating)

        return Effect.succeed<TrackedProfile>({
          platform: "atcoder",
          handle: handle.trim(),
          handleNormalized: normalizeHandle(handle),
          profileUrl: `https://atcoder.jp/users/${encodeURIComponent(handle)}`,
          rating,
          rankLabel,
          maxRating,
          rawPayload: payload
        }).pipe(
          Effect.tap(() =>
            Effect.logDebug(
              `Fetched AtCoder profile for ${handle}: rating=${rating}, rank=${rankLabel}`
            )
          )
        )
      }),
      Effect.retry(retrySchedule),
      Effect.mapError((cause) =>
        cause instanceof ProfileSourceError
          ? cause
          : new ProfileSourceError({
              platform: "atcoder",
              handle,
              reason: "Failed to fetch AtCoder profile",
              cause
            })
      )
    )

export const ProfileSourceServiceLive = Layer.effect(
  ProfileSourceService,
  Effect.gen(function* () {
    const httpClient = yield* HttpClient.HttpClient

    return {
      fetchProfile: (platform, handle) =>
        platform === "codeforces"
          ? fetchCodeforcesProfile(httpClient, handle)
          : fetchAtCoderProfile(httpClient, handle)
    }
  })
)
