import { HttpClient, HttpClientResponse } from "@effect/platform"
import { Effect } from "effect"

import { DbService } from "../services/db"

export interface CfProblem {
  readonly contestId: number
  readonly index: string
  readonly name: string
  readonly rating: number
  readonly tags: readonly string[]
  readonly url: string
}

type RawProblem = {
  contestId?: number
  index?: string
  name?: string
  rating?: number
  tags?: string[]
}

const fetchFromApi = (
  httpClient: HttpClient.HttpClient,
): Effect.Effect<CfProblem[], never> =>
  httpClient.get("https://codeforces.com/api/problemset.problems").pipe(
    Effect.flatMap(HttpClientResponse.filterStatusOk),
    Effect.flatMap((r) => r.json),
    Effect.map((payload) => {
      const data = payload as { status?: string; result?: { problems?: unknown[] } }
      if (data.status !== "OK") return []
      return (data.result?.problems ?? []) as RawProblem[]
    }),
    Effect.map((raw) =>
      raw
        .filter((p) => typeof p.rating === "number" && p.contestId !== undefined && p.index !== undefined)
        .map((p) => ({
          contestId: p.contestId!,
          index: p.index!,
          name: p.name ?? "Unknown",
          rating: p.rating!,
          tags: p.tags ?? [],
          url: `https://codeforces.com/problemset/problem/${p.contestId}/${p.index}`,
        }))
    ),
    Effect.catchAll(() => Effect.succeed([] as CfProblem[])),
  )

export const fetchRandomProblem = (
  minRating: number,
  maxRating: number,
): Effect.Effect<CfProblem | null, never, HttpClient.HttpClient | DbService> =>
  Effect.gen(function* () {
    const httpClient = yield* HttpClient.HttpClient
    const db = yield* DbService

    let problems: CfProblem[]

    const cached = yield* db.getCachedProblems.pipe(Effect.orElseSucceed(() => null))
    if (cached) {
      yield* Effect.logDebug("[codeforces] problem cache=hit")
      problems = JSON.parse(cached) as CfProblem[]
    } else {
      yield* Effect.logInfo("[codeforces] problem cache=miss fetching from API")
      problems = yield* fetchFromApi(httpClient)
      if (problems.length > 0) {
        yield* db.setCachedProblems(JSON.stringify(problems)).pipe(Effect.orElseSucceed(() => undefined))
        yield* Effect.logInfo(`[codeforces] cached ${problems.length} problems`)
      }
    }

    const candidates = problems.filter((p) => p.rating >= minRating && p.rating <= maxRating)
    if (candidates.length === 0) return null
    return candidates[Math.floor(Math.random() * candidates.length)]!
  })
