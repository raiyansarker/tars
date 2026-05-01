import {
  HttpClient,
  HttpClientResponse
} from "@effect/platform"
import { Context, Data, Effect, Either, Layer, Schedule, Schema } from "effect"

import { AppConfig } from "../config"
import type { Contest } from "../domain/contest"
import { parseAtCoderDate, parseDurationToMinutes, sortContests } from "../lib/time"

export class ContestSourceError extends Data.TaggedError("ContestSourceError")<{
  readonly source: string
  readonly reason: string
  readonly cause?: unknown
}> {}

export interface ContestCatalogService {
  readonly getUpcomingContests: Effect.Effect<ReadonlyArray<Contest>, ContestSourceError>
  readonly refresh: Effect.Effect<ReadonlyArray<Contest>, ContestSourceError>
}

export const ContestCatalogService =
  Context.GenericTag<ContestCatalogService>("ContestCatalogService")

const retrySchedule = Schedule.exponential("250 millis").pipe(
  Schedule.jittered,
  Schedule.intersect(Schedule.recurs(2))
)

const CodeforcesContestSchema = Schema.Struct({
  id: Schema.Number,
  name: Schema.String,
  type: Schema.String,
  phase: Schema.String,
  durationSeconds: Schema.Number,
  startTimeSeconds: Schema.Number
})

const CodeforcesResponseSchema = Schema.Struct({
  status: Schema.Literal("OK"),
  result: Schema.Array(CodeforcesContestSchema)
})

type CodeforcesContest = typeof CodeforcesContestSchema.Type

const decodeCodeforcesContests = (payload: unknown): ReadonlyArray<CodeforcesContest> =>
  Schema.decodeUnknownSync(CodeforcesResponseSchema)(payload).result

export const normalizeCodeforcesContests = (
  contests: ReadonlyArray<CodeforcesContest>
): ReadonlyArray<Contest> =>
  contests
    .filter((contest) => contest.phase === "BEFORE")
    .map((contest) => ({
      id: `codeforces-${contest.id}`,
      platform: "Codeforces" as const,
      title: contest.name,
      url: `https://codeforces.com/contests/${contest.id}`,
      startAt: new Date(contest.startTimeSeconds * 1000),
      durationMinutes: Math.round(contest.durationSeconds / 60),
      contestType: contest.type
    }))

const contestSections = ["Upcoming Contests", "Daily Contests"] as const

const sectionPattern = (headingText: string): RegExp =>
  new RegExp(
    `<h3[^>]*>\\s*${headingText.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*<\\/h3>([\\s\\S]*?)(?=<h3[^>]*>|$)`,
    "i"
  )

const stripTags = (value: string): string =>
  value.replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim()

const parseAtCoderContestTable = (tableHtml: string): ReadonlyArray<Contest> =>
  [...tableHtml.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)].flatMap((rowMatch) => {
    const rowHtml = rowMatch[1] ?? ""
    const cells = [...rowHtml.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map(
      (match) => match[1]
    )

    const [startCell, contestCell, durationCell, ratedCell] = cells
    if (!startCell || !contestCell || !durationCell || !ratedCell) {
      return []
    }

    const startAtText = stripTags(startCell)
    const durationText = stripTags(durationCell)
    const ratedRange = stripTags(ratedCell) || undefined
    const href = contestCell.match(/href="([^"]+)"/i)?.[1]
    const title = stripTags(contestCell)

    if (!startAtText || !title || !href || !durationText) {
      return []
    }

    const contestId = href.split("/").filter(Boolean).pop()
    if (!contestId) {
      return []
    }

    const contest: Contest = {
      id: `atcoder-${contestId}`,
      platform: "AtCoder",
      title,
      url: new URL(href, "https://atcoder.jp").toString(),
      startAt: parseAtCoderDate(startAtText),
      durationMinutes: parseDurationToMinutes(durationText)
    }

    return [ratedRange ? { ...contest, ratedRange } : contest]
  })

export const parseAtCoderContestsFromHtml = (html: string): ReadonlyArray<Contest> => {
  const contests = contestSections.flatMap((sectionName) => {
    const section = html.match(sectionPattern(sectionName))?.[1]
    if (!section) {
      return []
    }

    const table = section.match(/<table[\s\S]*?<\/table>/i)?.[0]
    return table ? parseAtCoderContestTable(table) : []
  })

  return sortContests(contests)
}

const fetchCodeforcesContests = (
  httpClient: HttpClient.HttpClient
): Effect.Effect<ReadonlyArray<Contest>, ContestSourceError> =>
  httpClient
    .get("https://codeforces.com/api/contest.list?gym=false")
    .pipe(
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.flatMap((response) => response.json),
      Effect.map(decodeCodeforcesContests),
      Effect.map(normalizeCodeforcesContests),
      Effect.retry(retrySchedule),
      Effect.mapError(
        (cause) =>
          new ContestSourceError({
            source: "Codeforces",
            reason: "Failed to fetch or decode contest data",
            cause
          })
      )
    )

const fetchAtCoderContests = (
  httpClient: HttpClient.HttpClient
): Effect.Effect<ReadonlyArray<Contest>, ContestSourceError> =>
  httpClient
    .get("https://atcoder.jp/contests/")
    .pipe(
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.flatMap((response) => response.text),
      Effect.map(parseAtCoderContestsFromHtml),
      Effect.retry(retrySchedule),
      Effect.mapError(
        (cause) =>
          new ContestSourceError({
            source: "AtCoder",
            reason: "Failed to fetch or parse contest page",
            cause
          })
      )
    )

export const ContestCatalogServiceLive = Layer.effect(
  ContestCatalogService,
  Effect.gen(function* () {
    const config = yield* AppConfig
    const httpClient = yield* HttpClient.HttpClient
    const cacheTtlMs = config.contestCacheTtlSeconds * 1000
    let cache:
      | {
          readonly fetchedAt: number
          readonly contests: ReadonlyArray<Contest>
        }
      | undefined

    const refresh = Effect.gen(function* () {
      const [codeforcesResult, atCoderResult] = yield* Effect.all(
        [
          fetchCodeforcesContests(httpClient).pipe(Effect.either),
          fetchAtCoderContests(httpClient).pipe(Effect.either)
        ],
        { concurrency: 2 }
      )

      const contests: Contest[] = []

      if (Either.isRight(codeforcesResult)) {
        yield* Effect.logDebug(`Fetched ${codeforcesResult.right.length} contests from Codeforces`)
        contests.push(...codeforcesResult.right)
      } else {
        yield* Effect.logWarning(
          `Codeforces source unavailable: ${codeforcesResult.left.reason}`
        )
      }

      if (Either.isRight(atCoderResult)) {
        yield* Effect.logDebug(`Fetched ${atCoderResult.right.length} contests from AtCoder`)
        contests.push(...atCoderResult.right)
      } else {
        yield* Effect.logWarning(`AtCoder source unavailable: ${atCoderResult.left.reason}`)
      }

      if (contests.length === 0) {
        return yield* Effect.fail(
          new ContestSourceError({
            source: "Combined",
            reason: "All contest sources failed"
          })
        )
      }

      const sorted = sortContests(contests)
      cache = {
        fetchedAt: Date.now(),
        contests: sorted
      }

      return sorted
    })

    return {
      refresh,
      getUpcomingContests: Effect.gen(function* () {
        if (cache && Date.now() - cache.fetchedAt < cacheTtlMs) {
          return cache.contests
        }

        return yield* refresh
      })
    }
  })
)
