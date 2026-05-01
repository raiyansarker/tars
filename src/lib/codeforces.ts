import { HttpClient, HttpClientResponse } from "@effect/platform"
import { Effect } from "effect"

export interface CfProblem {
  readonly contestId: number
  readonly index: string
  readonly name: string
  readonly rating: number
  readonly tags: readonly string[]
  readonly url: string
}

const CACHE_TTL_MS = 24 * 60 * 60 * 1000 // 24 hours
let problemCache: { fetchedAt: number; problems: CfProblem[] } | undefined

export const fetchRandomProblem = (
  rating: number
): Effect.Effect<CfProblem | null, never, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const now = Date.now()

    if (!problemCache || now - problemCache.fetchedAt > CACHE_TTL_MS) {
      const client = yield* HttpClient.HttpClient
      const result = yield* client.get("https://codeforces.com/api/problemset.problems").pipe(
        Effect.flatMap(HttpClientResponse.filterStatusOk),
        Effect.flatMap((r) => r.json),
        Effect.map((payload) => {
          const data = payload as { status?: string; result?: { problems?: unknown[] } }
          if (data.status !== "OK") return []
          return (data.result?.problems ?? []) as Array<{
            contestId?: number
            index?: string
            name?: string
            rating?: number
            tags?: string[]
          }>
        }),
        Effect.catchAll(() => Effect.succeed([])),
      )

      problemCache = {
        fetchedAt: now,
        problems: result
          .filter((p) => typeof p.rating === "number" && p.contestId !== undefined && p.index !== undefined)
          .map((p) => ({
            contestId: p.contestId!,
            index: p.index!,
            name: p.name ?? "Unknown",
            rating: p.rating!,
            tags: p.tags ?? [],
            url: `https://codeforces.com/problemset/problem/${p.contestId}/${p.index}`
          }))
      }
    }

    const candidates = problemCache.problems.filter(
      (p) => p.rating >= rating && p.rating <= rating + 200
    )
    if (candidates.length === 0) return null
    return candidates[Math.floor(Math.random() * candidates.length)]!
  })
