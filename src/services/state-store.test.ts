import { expect, test, describe, mock } from "bun:test"
import { Effect, Layer, Context, ConfigProvider, LogLevel, Option } from "effect"
import { AppConfig } from "../config"
import { StateStoreService, StateStoreServiceLive, type UpsertSubscriptionInput } from "./state-store"

// Very simple in-memory Redis mock
const store = new Map<string, string>()
const hashStore = new Map<string, Map<string, string>>()
const setStore = new Map<string, Set<string>>()
const listStore = new Map<string, string[]>()

const mockClient = {
  connect: async () => {},
  quit: async () => {},
  hGetAll: async (key: string) => {
    const h = hashStore.get(key)
    if (!h) return {}
    return Object.fromEntries(h)
  },
  hSet: async (key: string, values: Record<string, string>) => {
    let h = hashStore.get(key)
    if (!h) {
      h = new Map()
      hashStore.set(key, h)
    }
    for (const [k, v] of Object.entries(values)) {
      h.set(k, v)
    }
  },
  sAdd: async (key: string, value: string) => {
    let s = setStore.get(key)
    if (!s) {
      s = new Set()
      setStore.set(key, s)
    }
    s.add(value)
  },
  sMembers: async (key: string) => {
    const s = setStore.get(key)
    return s ? Array.from(s) : []
  },
  set: async (key: string, value: string, options?: any) => {
    if (options?.NX && store.has(key)) return null
    store.set(key, value)
    return "OK"
  },
  get: async (key: string) => {
    return store.get(key) ?? null
  },
  del: async (key: string) => {
    store.delete(key)
  },
  lPush: async (key: string, value: string) => {
    let l = listStore.get(key)
    if (!l) {
      l = []
      listStore.set(key, l)
    }
    l.unshift(value)
  },
  lTrim: async (key: string, start: number, end: number) => {
    let l = listStore.get(key)
    if (l) {
      listStore.set(key, l.slice(start, end + 1))
    }
  },
  incr: async (key: string) => {
    let v = Number(store.get(key) ?? "0")
    v++
    store.set(key, String(v))
  }
}

mock.module("redis", () => ({
  createClient: () => mockClient
}))

describe("StateStoreService", () => {
  const configLayer = Layer.succeed(AppConfig, {
    discordBotToken: "token",
    discordPublicKey: "pub",
    discordApplicationId: "app",
    redisUrl: "redis://localhost",
    botUserName: "bot",
    port: 3000,
    defaultTimeZone: "UTC",
    defaultDeliveryHour: 10,
    defaultDeliveryMinute: 0,
    schedulerPollMinutes: 10,
    contestCacheTtlSeconds: 300,
    logLevel: LogLevel.None,
    selfUsageUrl: Option.none()
  })
  
  const testLayer = StateStoreServiceLive.pipe(Layer.provide(configLayer))

  test("setup creates or updates a channel subscription", async () => {
    store.clear()
    hashStore.clear()
    setStore.clear()

    const program = Effect.gen(function* () {
      const state = yield* StateStoreService
      const input: UpsertSubscriptionInput = {
        guildId: "g1",
        channelId: "c1",
        guildName: "Guild 1",
        channelName: "Channel 1",
        timezone: "UTC",
        deliveryHour: 12,
        deliveryMinute: 30,
        createdByUserId: "u1"
      }

      const created = yield* state.upsertSubscription(input)
      expect(created.channelId).toBe("c1")
      expect(created.enabled).toBe(true)

      // update
      const updated = yield* state.upsertSubscription({
        ...input,
        deliveryHour: 14
      })
      expect(updated.deliveryHour).toBe(14)
      expect(updated.enabled).toBe(true)
    })

    await Effect.runPromise(Effect.scoped(program.pipe(Effect.provide(testLayer))))
  })

  test("disable disables a subscription without deleting history", async () => {
    store.clear()
    hashStore.clear()
    setStore.clear()

    const program = Effect.gen(function* () {
      const state = yield* StateStoreService
      const input: UpsertSubscriptionInput = {
        guildId: "g2",
        channelId: "c2",
        guildName: "Guild 2",
        channelName: "Channel 2",
        timezone: "UTC",
        deliveryHour: 12,
        deliveryMinute: 30,
        createdByUserId: "u2"
      }

      yield* state.upsertSubscription(input)
      yield* state.disableSubscription("c2")
      
      const sub = yield* state.getSubscriptionByChannel("c2")
      expect(sub).toBeDefined()
      expect(sub?.enabled).toBe(false)
      expect(sub?.guildId).toBe("g2")
    })

    await Effect.runPromise(Effect.scoped(program.pipe(Effect.provide(testLayer))))
  })

  test("Redis state keys enforce uniqueness and dedupe correctly for digests", async () => {
    store.clear()
    hashStore.clear()
    setStore.clear()

    const program = Effect.gen(function* () {
      const state = yield* StateStoreService
      
      const claimed1 = yield* state.claimDigestDelivery("c1", "2023-01-01")
      expect(claimed1).toBe(true)
      
      const claimed2 = yield* state.claimDigestDelivery("c1", "2023-01-01")
      expect(claimed2).toBe(false) // duplicate claim fails
    })

    await Effect.runPromise(Effect.scoped(program.pipe(Effect.provide(testLayer))))
  })

  test("tracked-user improvement posts exactly one congratulation message per new better snapshot", async () => {
    store.clear()
    hashStore.clear()
    setStore.clear()

    const program = Effect.gen(function* () {
      const state = yield* StateStoreService
      
      const claimed1 = yield* state.claimTrackingAnnouncement("t1", "snap1")
      expect(claimed1).toBe(true)
      
      const claimed2 = yield* state.claimTrackingAnnouncement("t1", "snap1")
      expect(claimed2).toBe(false) // duplicate claim fails for the same snapshot
      
      const claimed3 = yield* state.claimTrackingAnnouncement("t1", "snap2")
      expect(claimed3).toBe(true) // new snapshot can be claimed
    })

    await Effect.runPromise(Effect.scoped(program.pipe(Effect.provide(testLayer))))
  })
})
