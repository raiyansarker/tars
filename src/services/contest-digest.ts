import { Context, Effect, Layer, Option } from "effect"

import type { Contest, ContestDigest, ContestPlatform } from "../domain/contest"
import { escMd } from "../lib/tracking";
import {
  addDaysToDateKey,
  filterContestsByDateKey,
  formatContestStart,
  formatDateKeyForHumans,
  formatDateKeyInTimeZone,
  formatDuration,
  getTomorrowDateKey,
  sortContests
} from "../lib/time"
import {
  ContestCatalogService,
  type ContestSourceError
} from "./contest-sources"

export type DigestScope = "today" | "tomorrow"

export interface ContestDigestService {
  readonly getDigest: (
    scope: DigestScope,
    timeZone: string,
    now?: Date
  ) => Effect.Effect<ContestDigest, ContestSourceError>
  readonly getUpcomingRange: (
    days: number,
    timeZone: string,
    now?: Date
  ) => Effect.Effect<ContestDigest, ContestSourceError>
  readonly getNextUpcomingContest: (
    timeZone: string,
    now?: Date
  ) => Effect.Effect<Contest | null, ContestSourceError>
  readonly pickLuckyContest: (
    timeZone: string,
    now?: Date
  ) => Effect.Effect<Contest | null, ContestSourceError>
}

export const ContestDigestService =
  Context.GenericTag<ContestDigestService>("ContestDigestService")

const orderedPlatforms: ReadonlyArray<ContestPlatform> = ["Codeforces", "AtCoder"]

const digestScopeLabel = (scope: DigestScope): string =>
  scope === "today" ? "Today's Contests" : "Tomorrow's Contests"

export const renderContestLine = (contest: Contest, timeZone: string): string => {
  const timeStr = formatContestStart(contest.startAt, timeZone)
  const durationStr = formatDuration(contest.durationMinutes)
  const rated = contest.ratedRange ? `  ·  Rated \`${contest.ratedRange}\`` : ""
  return [
    `**[${escMd(contest.title)}](<${contest.url}>)**`,
    `> \`${timeStr}\`  ·  \`${durationStr}\`${rated}`,
    ""
  ].join("\n")
}

export const buildDigestMessage = (
  contests: ReadonlyArray<Contest>,
  targetDateKeys: ReadonlyArray<string>,
  header: string,
  timeZone: string
): ContestDigest => {
  const selected = sortContests(
    contests.filter((contest) =>
      targetDateKeys.includes(formatDateKeyInTimeZone(contest.startAt, timeZone))
    )
  )

  const lines: string[] = [
    `## ${header}`,
    `> -# ${timeZone}`,
    ""
  ]

  if (selected.length === 0) {
    lines.push("*No contests found in this range.*")
    return {
      targetDateKey: targetDateKeys[0] || "unknown",
      contests: selected,
      message: lines.join("\n")
    }
  }

  for (const platform of orderedPlatforms) {
    const platformContests = selected.filter((c) => c.platform === platform)
    if (platformContests.length === 0) continue
    lines.push(`**${platform}**`, "")
    for (const contest of platformContests) {
      lines.push(renderContestLine(contest, timeZone))
    }
  }

  return {
    targetDateKey: targetDateKeys[0] || "unknown",
    contests: selected,
    message: lines.join("\n").trimEnd()
  }
}

export const ContestDigestServiceLive = Layer.effect(
  ContestDigestService,
  Effect.gen(function* () {
    const catalog = yield* ContestCatalogService

    const getSortedContests = catalog.getUpcomingContests.pipe(Effect.map(sortContests))

    return {
      getDigest: (scope, timeZone, now = new Date()) =>
        getSortedContests.pipe(
          Effect.map((contests) => {
            const dateKey = scope === "today" 
              ? formatDateKeyInTimeZone(now, timeZone)
              : getTomorrowDateKey(now, timeZone)
            return buildDigestMessage(
              contests, 
              [dateKey], 
              digestScopeLabel(scope), 
              timeZone
            )
          })
        ),
      getUpcomingRange: (days, timeZone, now = new Date()) =>
        getSortedContests.pipe(
          Effect.map((contests) => {
            const keys: string[] = []
            const startKey = formatDateKeyInTimeZone(now, timeZone)
            for (let i = 0; i < days; i++) {
              keys.push(addDaysToDateKey(startKey, i))
            }
            return buildDigestMessage(
              contests,
              keys,
              `Upcoming Contests (Next ${days} Days)`,
              timeZone
            )
          })
        ),
      getNextUpcomingContest: (timeZone, now = new Date()) =>
        getSortedContests.pipe(
          Effect.map((contests) =>
            contests.find((contest) => contest.startAt.getTime() > now.getTime()) ?? null
          )
        ),
      pickLuckyContest: (timeZone, now = new Date()) =>
        getSortedContests.pipe(
          Effect.map((contests) => {
            const tomorrowKey = getTomorrowDateKey(now, timeZone)
            const tomorrowContests = sortContests(
              filterContestsByDateKey(contests, tomorrowKey, timeZone)
            )
            const pool =
              tomorrowContests.filter((contest) => contest.durationMinutes <= 120).length > 0
                ? tomorrowContests.filter((contest) => contest.durationMinutes <= 120)
                : tomorrowContests

            if (pool.length === 0) {
              return null
            }

            const index = Math.floor(Math.random() * pool.length)
            return pool[index] ?? null
          })
        )
    }
  })
)

