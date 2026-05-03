import { expect, test, describe, mock } from "bun:test"
import { Effect, Layer, LogLevel, Option } from "effect"
import { AppConfig } from "../../src/config"
import { DbService, DbServiceLive, type UpsertSubscriptionInput } from "../../src/services/db"

// ── In-memory Redis mock ─────────────────────────────────────────────────────
const store = new Map<string, string>()

const mockRedis = {
  quit: async () => {},
  get: async (key: string) => store.get(key) ?? null,
  set: async (key: string, value: string, ...args: any[]) => {
    const hasNX = args.includes("NX") || args.includes("nx")
    if (hasNX && store.has(key)) return null
    store.set(key, value)
    return "OK"
  },
  del: async (...keys: string[]) => { for (const k of keys) store.delete(k) },
  keys: async (pattern: string) => {
    const prefix = pattern.replace("*", "")
    return [...store.keys()].filter((k) => k.startsWith(prefix))
  },
}

mock.module("ioredis", () => ({
  default: function () { return mockRedis },
}))

// ── Config layer ─────────────────────────────────────────────────────────────
const configLayer = Layer.succeed(AppConfig, {
  discordBotToken: "token",
  discordPublicKey: "pub",
  discordApplicationId: "app",
  redisUrl: "redis://localhost",
  tursoUrl: "file::memory:",
  tursoAuthToken: "",
  botUserName: "bot",
  port: 3000,
  defaultTimeZone: "UTC",
  defaultDeliveryHour: 10,
  defaultDeliveryMinute: 0,
  schedulerPollMinutes: 10,
  contestCacheTtlSeconds: 300,
  logLevel: LogLevel.None,
  selfUsageUrl: Option.none(),
  isDev: false,
  groqApiKey: "",
})

const testLayer = DbServiceLive.pipe(Layer.provide(configLayer))

const run = <A>(effect: Effect.Effect<A, unknown, DbService>) =>
  Effect.runPromise(Effect.scoped(effect.pipe(Effect.provide(testLayer))))

// ── Tests ────────────────────────────────────────────────────────────────────
describe("DbService — subscriptions", () => {
  test("creates and updates a channel subscription", async () => {
    await run(Effect.gen(function* () {
      const db = yield* DbService
      const input: UpsertSubscriptionInput = {
        guildId: "g1", channelId: "c1", guildName: "Guild 1", channelName: "Channel 1",
        timezone: "UTC", deliveryHour: 12, deliveryMinute: 30, createdByUserId: "u1",
      }
      const created = yield* db.upsertSubscription(input)
      expect(created.channelId).toBe("c1")
      expect(created.enabled).toBe(true)

      const updated = yield* db.upsertSubscription({ ...input, deliveryHour: 14 })
      expect(updated.deliveryHour).toBe(14)
      expect(updated.enabled).toBe(true)
    }))
  })

  test("disable sets enabled=false without deleting the row", async () => {
    await run(Effect.gen(function* () {
      const db = yield* DbService
      yield* db.upsertSubscription({
        guildId: "g2", channelId: "c2", guildName: null, channelName: null,
        timezone: "UTC", deliveryHour: 12, deliveryMinute: 0, createdByUserId: "u2",
      })
      yield* db.disableSubscription("c2")
      const sub = yield* db.getSubscriptionByChannel("c2")
      expect(sub).toBeDefined()
      expect(sub?.enabled).toBe(false)
      expect(sub?.guildId).toBe("g2")
    }))
  })
})

describe("DbService — claim/release (Redis)", () => {
  test("digest delivery claim is exclusive", async () => {
    store.clear()
    await run(Effect.gen(function* () {
      const db = yield* DbService
      const claimed1 = yield* db.claimDigestDelivery("c1", "2024-01-01")
      expect(claimed1).toBe(true)
      const claimed2 = yield* db.claimDigestDelivery("c1", "2024-01-01")
      expect(claimed2).toBe(false)
    }))
  })

  test("tracking announcement claim is exclusive per snapshot, not per handle", async () => {
    store.clear()
    await run(Effect.gen(function* () {
      const db = yield* DbService
      expect(yield* db.claimTrackingAnnouncement("t1", "snap1")).toBe(true)
      expect(yield* db.claimTrackingAnnouncement("t1", "snap1")).toBe(false)
      expect(yield* db.claimTrackingAnnouncement("t1", "snap2")).toBe(true)
    }))
  })
})

describe("DbService — leaderboard", () => {
  test("returns only codeforces entries sorted by rating descending", async () => {
    await run(Effect.gen(function* () {
      const db = yield* DbService
      const guildId = "g-lb"

      yield* db.addTrackedHandle(guildId, "codeforces", "tourist", "tourist", "u1")
      yield* db.addTrackedHandle(guildId, "codeforces", "neal", "neal", "u1")
      yield* db.addTrackedHandle(guildId, "atcoder", "rng_58", "rng_58", "u1")

      const [th1, th2] = yield* Effect.all([
        db.getTrackedHandleByGuild(guildId, "codeforces", "tourist"),
        db.getTrackedHandleByGuild(guildId, "codeforces", "neal"),
      ])

      yield* db.insertRatingSnapshot({ trackedHandleId: th1!.id, rating: 3800, rankLabel: "Legendary Grandmaster", maxRating: 3800, isImprovement: false, rawPayloadJson: {} })
      yield* db.insertRatingSnapshot({ trackedHandleId: th2!.id, rating: 3600, rankLabel: "Legendary Grandmaster", maxRating: 3600, isImprovement: false, rawPayloadJson: {} })

      const leaderboard = yield* db.getLeaderboard(guildId)
      expect(leaderboard.every((e) => e.platform === "codeforces")).toBe(true)
      expect(leaderboard.map((e) => e.handle)).toEqual(["tourist", "neal"])
    }))
  })
})
